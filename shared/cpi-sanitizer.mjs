/**
 * Reversible sanitizer for SAP CPI bundles (zero dependencies).
 *
 * sanitizeBundle() replaces confidential values (hosts, emails, IPs, credential aliases,
 * externalized parameter values, secrets, private namespaces and user-supplied terms) with
 * deterministic aliases that stay syntactically valid where they appear:
 *   host-001.sanitized.invalid   (URL authority / bare host)
 *   user-001@sanitized.invalid   (email)
 *   198.51.100.1                 (IPv4, RFC 5737 documentation range)
 *   urn:sanitized:ns-001         (private URN namespace)
 *   SANITIZED_CRED_001 / SANITIZED_PARAM_001 / SANITIZED_SECRET_001 / SANITIZED_TERM_001
 *
 * The alias -> original table is returned (and written by the CLI to a local map file that must
 * never be shared). restoreBundle() puts the originals back into a bundle the AI modified, refuses
 * aliases it does not know, and warns about aliases that disappeared.
 *
 * Nothing here prints values: reports contain counts, aliases and sanitized paths only.
 */
import { readZipEntries, createZipBuffer } from './zip-utils.mjs';
import { parseManifestSections, serializeManifestSections } from './manifest-utils.mjs';

export const SANITIZER_MAP_VERSION = 1;
export const SANITIZE_CATEGORIES = ['secrets', 'urls', 'namespaces', 'emails', 'ips', 'hosts', 'credentials', 'params', 'terms'];
const FIXED_ZIP_DATE = new Date(2020, 0, 1, 0, 0, 0);
const MAX_PER_KIND = 999;

/** Any alias token produced by this module (fixed 3-digit counters keep the boundary unambiguous). */
export const ALIAS_TOKEN_RE =
  /SANITIZED_[A-Z]+_\d{3}|[a-z]+-\d{3}\.sanitized\.invalid|[a-z]+-\d{3}@sanitized\.invalid|urn:sanitized:[a-z]+-\d{3}|(?<![\d.])(?:198\.51\.100|203\.0\.113)\.\d{1,3}(?![\d.])/g;
/** Strong markers only (no IP range): used by the inspector / packager to refuse sanitized bundles. */
export const SANITIZED_MARKER_RE = /SANITIZED_(?:CRED|PARAM|SECRET|TERM)_\d{3}|\.sanitized\.invalid|@sanitized\.invalid|urn:sanitized:/;

const STANDARD_HOSTS = new Set([
  'w3.org', 'www.w3.org', 'www.omg.org', 'omg.org', 'schemas.xmlsoap.org', 'xmlsoap.org', 'docs.oasis-open.org',
  'www.oasis-open.org', 'xml.apache.org', 'camel.apache.org', 'www.apache.org', 'json-schema.org', 'purl.org',
  'schemas.microsoft.com', 'schemas.openxmlformats.org', 'www.xml.org', 'xml.org', 'sap.com', 'www.sap.com',
  'help.sap.com', 'api.sap.com', 'example.com', 'www.example.com', 'example.org', 'example.net', 'localhost',
  'groovy-lang.org', 'www.wssc.org', 'schemas.datacontract.org', 'xmlns.com', 'ns.adobe.com', 'www.iana.org',
  // Feature/function URIs of XML parsers and XSLT engines: replacing them changes runtime behaviour (e.g. XXE protection)
  'apache.org', 'java.sun.com', 'xmlpull.org', 'www.xmlpull.org', 'saxon.sf.net', 'saxonica.com',
  'www.saxonica.com', 'exslt.org', 'www.exslt.org', 'json.org', 'www.json.org', 'jcp.org', 'xmlns.jcp.org'
]);
const STANDARD_HOST_SUFFIXES = ['.w3.org', '.apache.org', '.xml.org', '.sanitized.invalid', '.example.com', '.example.org', '.oasis-open.org', '.xmlsoap.org'];
const STANDARD_URN_NIDS = new Set(['ietf', 'oasis', 'sap-com', 'sap', 'schemas-microsoft-com', 'iso', 'uuid', 'isbn', 'xmpp', 'un', 'iana', 'mpeg', 'oid', 'sanitized']);
const TLDS = 'com|net|org|io|cloud|local|corp|internal|intra|lan|int|eu|es|de|fr|it|uk|us|ch|nl|be|pt|at|mx|br|ar|cl|co|info|biz|app|dev|ai|aws|sap|ondemand';
const CREDENTIAL_KEYS = /(credential|alias)$|^(credentialName|credentials|user|userName|username|proxyUser|destinationName|locationID|locationId|scc_location_id|clientId|client_id|audience|bucketName|accountName|tenant|tenantName|privateKeyAlias|publicKeyAlias|password|apiKey|token)$/i;
const ADAPTER_META_KEY_RE = /<key>\s*(?:Vendor|cmdVariantUri|componentVersion|ComponentNS|ComponentSWCVName|ComponentSWCVId)\s*<\/key>\s*<value>[^<]*$/;
const TEXT_EXT =/\.(iflw|groovy|gsh|js|xsd|xsl|xslt|mmap|wsdl|edmx|xml|json|txt|csv|prop|propdef|mf|project|properties|yaml|yml|html|sql)$/i;
const SAMPLE_PATH = /(^|\/)src\/main\/resources\/(?!scenarioflows\/|script\/|mapping\/|xsd\/|wsdl\/|edmx\/|xslt?\/|json\/)[^]*\.(xml|json|csv|txt|dat)$|(^|\/)[^/]*(sample|example|mock|payload|test)[^/]*\.(xml|json|csv|txt|dat)$/i;

const pad = (n) => String(n).padStart(3, '0');
const isPlaceholder = (v) => /\{\{|\$\{/.test(v);
const isAliasLike = (s) => new RegExp(ALIAS_TOKEN_RE.source).test(s);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isStandardHost(host) {
  const h = String(host || '').toLowerCase();
  return STANDARD_HOSTS.has(h) || STANDARD_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

/** Alias registry: same original -> same alias, across every file and bundle of one map. */
export class AliasRegistry {
  constructor(existing = null) {
    this.aliases = {}; // alias -> { kind, original }
    this.byOriginal = new Map(); // kind + \0 + original -> alias
    this.counters = {};
    if (existing && existing.aliases) {
      for (const [alias, rec] of Object.entries(existing.aliases)) this._remember(alias, rec.kind, rec.original);
      Object.assign(this.counters, existing.counters || {});
    }
  }
  _remember(alias, kind, original) {
    this.aliases[alias] = { kind, original };
    this.byOriginal.set(kind + '\0' + original, alias);
  }
  get(kind, original) {
    const key = kind + '\0' + original;
    if (this.byOriginal.has(key)) return this.byOriginal.get(key);
    const n = (this.counters[kind] || 0) + 1;
    this.counters[kind] = n;
    if (n > MAX_PER_KIND) throw new Error(`Demasiados valores distintos de tipo ${kind} (máximo ${MAX_PER_KIND}).`);
    let alias;
    switch (kind) {
      case 'host': alias = `host-${pad(n)}.sanitized.invalid`; break;
      case 'email': alias = `user-${pad(n)}@sanitized.invalid`; break;
      case 'ns': alias = `urn:sanitized:ns-${pad(n)}`; break;
      case 'ip': alias = n <= 254 ? `198.51.100.${n}` : `203.0.113.${n - 254}`; if (n > 508) throw new Error('Demasiadas IPs distintas (máximo 508).'); break;
      default: alias = `SANITIZED_${kind.toUpperCase()}_${pad(n)}`;
    }
    this._remember(alias, kind, original);
    return alias;
  }
  toJSON() {
    return { aliases: this.aliases, counters: this.counters };
  }
}

/** Applies every enabled detector to one text. Returns { text, counts }. */
export function sanitizeText(text, { reg, path: entryPath = '', enabled, terms = [] }) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const on = (c) => enabled.has(c);
  const lower = entryPath.toLowerCase();
  const isManifest = lower.endsWith('manifest.mf');
  const isIflw = lower.endsWith('.iflw');
  const isProp = lower.endsWith('.prop') && !lower.endsWith('metainfo.prop');
  let t = text;

  // 1. externalized parameter values (.prop): whole value, except empty / boolean / numeric
  if (isProp && on('params')) {
    const lines = t.split(/(\r?\n)/);
    let continuing = false;
    for (let i = 0; i < lines.length; i += 2) {
      const line = lines[i];
      const wasContinuing = continuing;
      continuing = /(^|[^\\])(\\\\)*\\$/.test(line);
      if (wasContinuing) continue; // continuation lines stay attached to the alias below
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const m = /^(\s*(?:\\.|[^=:\s\\])+\s*[=:\s]\s*)([^]*)$/.exec(line);
      if (!m) continue;
      let value = m[2];
      let j = i;
      let chunk = line;
      while (/(^|[^\\])(\\\\)*\\$/.test(chunk) && j + 2 < lines.length) {
        value += lines[j + 1] + lines[j + 2];
        chunk = lines[j + 2];
        lines[j + 1] = '';
        lines[j + 2] = '';
        j += 2;
      }
      if (j > i) continuing = false;
      if (!value.trim() || /^(true|false|-?\d+(\.\d+)?)\s*$/i.test(value) || isAliasLike(value)) continue;
      lines[i] = m[1] + reg.get('param', value);
      bump('params');
    }
    t = lines.join('');
  }

  // 2. secrets
  if (on('secrets')) {
    t = t.replace(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g, (s) => (bump('secrets'), reg.get('secret', s)));
    t = t.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, (s) => (bump('secrets'), reg.get('secret', s)));
    t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, (s) => (bump('secrets'), reg.get('secret', s)));
    t = t.replace(/(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, (all, p, s) => (isAliasLike(s) ? all : (bump('secrets'), p + reg.get('secret', s))));
    t = t.replace(
      /(\b(?:password|passwd|pwd|secret|client_?secret|token|api_?key|access_?key|secret_?key)["']?\s*[:=]\s*["'])([^"'\s]{4,})(["'])/gi,
      (all, p, s, q) => (isPlaceholder(s) || isAliasLike(s) ? all : (bump('secrets'), p + reg.get('secret', s) + q))
    );
  }

  // 3. URL authorities (userinfo + host), port/path/query are kept
  if (on('urls')) {
    t = t.replace(
      /\b((?:https?|sftp|ftps?|amqps?|wss?|ldaps?|smtps?|imaps?|mqtt|tcp|jdbc:[a-z0-9]+)\\?:\/\/)([^\s/"'<>{}\\?#|`]+)/gi,
      (all, scheme, authority) => {
        if (isPlaceholder(authority) || /^[$%]/.test(authority) || isAliasLike(authority)) return all;
        const at = authority.lastIndexOf('@');
        const hostPort = authority.slice(at + 1);
        const portMatch = /:(\d+)$/.exec(hostPort);
        const host = portMatch ? hostPort.slice(0, portMatch.index) : hostPort;
        if (!host || host.startsWith('[')) return all;
        if (at < 0 && isStandardHost(host)) return all;
        const core = authority.slice(0, authority.length - (portMatch ? portMatch[0].length : 0));
        bump('urls');
        return scheme + reg.get('host', core) + (portMatch ? portMatch[0] : '');
      }
    );
  }

  // 4. private URN namespaces
  if (on('namespaces')) {
    t = t.replace(/\burn:([A-Za-z0-9][A-Za-z0-9.-]*):([^\s"'<>]+)/g, (all, nid) => {
      if (STANDARD_URN_NIDS.has(nid.toLowerCase())) return all;
      bump('namespaces');
      return reg.get('ns', all);
    });
  }

  // 5. emails
  if (on('emails')) {
    t = t.replace(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g, (all, domain) => {
      if (isStandardHost(domain) || !/\.[A-Za-z]{2,24}$/.test(domain) || isAliasLike(all)) return all;
      bump('emails');
      return reg.get('email', all);
    });
  }

  // 6. IPv4 (not version numbers, not loopback/any)
  if (on('ips') && !isManifest) {
    t = t.replace(/(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])/g, (all, ip, offset, whole) => {
      if (['0.0.0.0', '127.0.0.1', '255.255.255.255'].includes(ip) || reg.aliases[ip]) return all;
      if (/version|::\s*$/i.test(whole.slice(Math.max(0, offset - 30), offset))) return all;
      bump('ips');
      return reg.get('ip', ip);
    });
  }

  // 7. bare host names (not Java/Groovy packages: the last label must be a TLD)
  if (on('hosts') && !isManifest) {
    const hostRe = new RegExp(`(?<![\\w.@/\\\\-])((?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\.)+(?:${TLDS}))(?![\\w-]|\\.[\\w-])`, 'gi');
    t = t.replace(hostRe, (all, _h, offset, whole) => {
      if (isStandardHost(all) || isAliasLike(all) || /^(com|org|net|java|javax|groovy|io)\./i.test(all)) return all;
      // adapter metadata (cmdVariantUri "vendor::X/version::Y", Vendor, componentVersion) is not an endpoint
      const before = whole.slice(Math.max(0, offset - 200), offset);
      if (before.endsWith('::') || ADAPTER_META_KEY_RE.test(before)) return all;
      bump('hosts');
      return reg.get('host', all);
    });
  }

  // 8. credential-like iFlow properties that are not externalized
  if (isIflw && on('credentials')) {
    t = t.replace(/(<key>([^<]+)<\/key>\s*<value>)([^<]+)(<\/value>)/g, (all, pre, key, value, post) => {
      if (!CREDENTIAL_KEYS.test(key.trim()) || !value.trim() || isPlaceholder(value) || isAliasLike(value)) return all;
      bump('credentials');
      return pre + reg.get('cred', value) + post;
    });
  }

  // 9. externalized values reused elsewhere (iFlow name in MANIFEST, field names in XSD/Groovy...):
  //    same alias, whole identifier only, so the bundle stays consistent
  if (on('params') && !isProp) {
    const re = paramPropagationRegex(reg);
    if (re) t = splitOutsideAliases(t, (part) => part.replace(re, (m) => (bump('params'), reg.get('param', m))));
  }

  // 10. user terms (client / project names): exact casing gets its own alias
  if (on('terms') && terms.length) {
    t = applyTerms(t, terms, reg, () => bump('terms'));
  }
  return { text: t, counts };
}

const MIN_PROPAGATE = 6;
function paramPropagationRegex(reg) {
  const values = Object.values(reg.aliases)
    .filter((a) => a.kind === 'param' && a.original.length >= MIN_PROPAGATE && !/[\r\n\\]/.test(a.original) && !/^\s|\s$/.test(a.original))
    .map((a) => a.original)
    .sort((a, b) => b.length - a.length);
  if (!values.length) return null;
  if (reg._propKey === values.length) return reg._propRe;
  reg._propKey = values.length;
  reg._propRe = new RegExp(`(?<![A-Za-z0-9_])(?:${values.map(escRe).join('|')})(?![A-Za-z0-9_])`, 'g');
  return reg._propRe;
}

function splitOutsideAliases(t, fn) {
  const parts = t.split(new RegExp(`(${ALIAS_TOKEN_RE.source})`, 'g'));
  return parts.map((part, idx) => (idx % 2 === 1 ? part : fn(part))).join('');
}

function applyTerms(t, terms, reg, onHit = () => {}) {
  const sorted = [...new Set(terms)].sort((a, b) => b.length - a.length);
  const re = new RegExp(sorted.map(escRe).join('|'), 'gi');
  // never rewrite inside an alias token
  const parts = t.split(new RegExp(`(${ALIAS_TOKEN_RE.source})`, 'g'));
  return parts
    .map((part, idx) => (idx % 2 === 1 ? part : part.replace(re, (m) => (onHit(), reg.get('term', m)))))
    .join('');
}

export function normalizeTerms(list) {
  const out = [];
  for (const raw of list || []) {
    const s = String(raw).trim();
    if (!s) continue;
    if (s.length < 3) throw new Error(`El término "${s.length} caracteres" es demasiado corto (mínimo 3).`);
    if (/sanitized/i.test(s)) throw new Error('Un término no puede contener "sanitized".');
    out.push(s);
  }
  return out;
}

const isZipBuffer = (b) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50;
function decodeText(entry) {
  if (entry.data.includes(0)) return null;
  const s = entry.data.toString('utf8');
  if (!TEXT_EXT.test(entry.path) && !Buffer.from(s, 'utf8').equals(entry.data)) return null;
  return Buffer.from(s, 'utf8').equals(entry.data) ? s : null;
}

/** MANIFEST: unfold, transform, refold only when something changed (keeps original bytes otherwise). */
function transformManifest(text, fn) {
  const sections = parseManifestSections(text);
  let changed = false;
  const out = sections.map((lines) => lines.map((l) => { const n = fn(l); if (n !== l) changed = true; return n; }));
  return changed ? serializeManifestSections(out) : text;
}

/**
 * Sanitizes a bundle (path or Buffer). Nested ZIPs (content packages) are processed recursively.
 * @returns {{ buffer: Buffer, files: Array, totals: object, dropped: Array, aliasesUsed: string[] }}
 */
export function sanitizeBundle(input, { registry, categories = SANITIZE_CATEGORIES, terms = [], dropSamples = false, prefix = '' } = {}) {
  const reg = registry || new AliasRegistry();
  const enabled = new Set(categories);
  const entries = readZipEntries(input);
  const out = [];
  const files = [];
  const dropped = [];
  const totals = {};
  const used = new Set();
  const add = (counts) => { for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v; };
  const before = new Set(Object.keys(reg.aliases));
  const termList = normalizeTerms(terms);

  for (const e of entries) {
    const text = isZipBuffer(e.data) ? null : decodeText(e);
    if (text !== null && SANITIZED_MARKER_RE.test(text)) {
      throw new Error(`"${prefix}${e.path}" ya contiene alias de limpieza: este bundle parece estar ya limpiado.`);
    }
  }

  // .prop files first so their values can be propagated to the rest of the bundle
  const isPropEntry = (e) => /.prop$/i.test(e.path) && !/metainfo.prop$/i.test(e.path);
  const order = [...entries.filter(isPropEntry), ...entries.filter((e) => !isPropEntry(e))];
  const outByEntry = new Map();
  const outPush = (e, item) => outByEntry.set(e, item);
  for (const e of order) {
    const newPath = enabled.has('terms') && termList.length ? applyTerms(e.path, termList, reg) : e.path;
    if (dropSamples && SAMPLE_PATH.test(e.path) && !isZipBuffer(e.data)) {
      dropped.push({ path: prefix + e.path, base64: e.data.toString('base64') });
      files.push({ path: prefix + newPath, dropped: true });
      continue;
    }
    if (isZipBuffer(e.data)) {
      const nested = sanitizeBundle(e.data, { registry: reg, categories, terms: termList, dropSamples, prefix: `${prefix}${e.path}!/` });
      out.push({ path: newPath, content: nested.buffer });
      files.push(...nested.files);
      dropped.push(...nested.dropped);
      add(nested.totals);
      nested.aliasesUsed.forEach((a) => used.add(a));
      continue;
    }
    const text = decodeText(e);
    if (text === null) {
      out.push({ path: newPath, content: e.data });
      continue;
    }
    let counts = {};
    let result;
    if (e.path.toLowerCase().endsWith('manifest.mf')) {
      result = transformManifest(text, (line) => {
        const r = sanitizeText(line, { reg, path: e.path, enabled, terms: termList });
        for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + v;
        return r.text;
      });
    } else {
      const r = sanitizeText(text, { reg, path: e.path, enabled, terms: termList });
      result = r.text;
      counts = r.counts;
    }
    for (const m of result.matchAll(ALIAS_TOKEN_RE)) if (reg.aliases[m[0]]) used.add(m[0]);
    for (const m of newPath.matchAll(ALIAS_TOKEN_RE)) if (reg.aliases[m[0]]) used.add(m[0]);
    if (newPath !== e.path) counts.paths = 1;
    add(counts);
    if (Object.keys(counts).length) files.push({ path: prefix + newPath, replacements: counts });
    out.push({ path: newPath, content: result === text ? e.data : Buffer.from(result, 'utf8') });
  }
  const seen = new Set();
  for (const f of out) {
    if (seen.has(f.path)) throw new Error(`Colisión de rutas tras aplicar los términos: ${prefix}${f.path}`);
    seen.add(f.path);
  }
  return {
    buffer: createZipBuffer(out, { date: FIXED_ZIP_DATE }),
    files,
    dropped,
    totals,
    aliasesUsed: [...used].sort(),
    newAliases: Object.keys(reg.aliases).filter((a) => !before.has(a)).length
  };
}

function restoreText(text, aliases, unknown, found) {
  return text.replace(ALIAS_TOKEN_RE, (tok) => {
    const rec = aliases[tok];
    if (!rec) {
      unknown.add(tok);
      return tok;
    }
    found.add(tok);
    return rec.original;
  });
}

/**
 * Restores the originals into a (possibly modified) sanitized bundle.
 * @returns {{ ok: boolean, buffer?: Buffer, unknownAliases: string[], missingAliases: string[], restoredFiles: number, readdedFiles: number }}
 */
export function restoreBundle(input, map, { prefix = '', expected = null } = {}) {
  const aliases = map.aliases || {};
  const entries = readZipEntries(input);
  const unknown = new Set();
  const found = new Set();
  const out = [];
  let restoredFiles = 0;
  let readded = 0;
  for (const e of entries) {
    const newPath = restoreText(e.path, aliases, unknown, found);
    if (isZipBuffer(e.data)) {
      const nested = restoreBundle(e.data, map, { prefix: `${prefix}${newPath}!/`, expected: [] });
      nested.unknownAliases.forEach((a) => unknown.add(a));
      nested.foundAliases.forEach((a) => found.add(a));
      restoredFiles += nested.restoredFiles;
      readded += nested.readdedFiles;
      out.push({ path: newPath, content: nested.buffer || e.data });
      continue;
    }
    const text = decodeText(e);
    if (text === null) {
      out.push({ path: newPath, content: e.data });
      continue;
    }
    let result;
    if (e.path.toLowerCase().endsWith('manifest.mf')) {
      result = transformManifest(text, (line) => restoreText(line, aliases, unknown, found));
    } else {
      result = restoreText(text, aliases, unknown, found);
    }
    if (result !== text || newPath !== e.path) restoredFiles++;
    out.push({ path: newPath, content: result === text ? e.data : Buffer.from(result, 'utf8') });
  }
  for (const d of map.dropped || []) {
    if (!d.path.startsWith(prefix)) continue;
    const rel = d.path.slice(prefix.length);
    if (rel.includes('!/')) continue;
    if (!out.some((f) => f.path === rel)) {
      out.push({ path: rel, content: Buffer.from(d.base64, 'base64') });
      readded++;
    }
  }
  const missing = (expected || []).filter((a) => !found.has(a));
  const ok = unknown.size === 0;
  return {
    ok,
    buffer: ok ? createZipBuffer(out, { date: FIXED_ZIP_DATE }) : null,
    unknownAliases: [...unknown].sort(),
    missingAliases: missing.sort(),
    foundAliases: [...found],
    restoredFiles,
    readdedFiles: readded
  };
}

/** True when a bundle (entries already read) still contains sanitization aliases. */
export function findSanitizedEntries(entries, prefix = '') {
  const hits = [];
  for (const e of entries) {
    if (isZipBuffer(e.data)) {
      // content packages nest one zip per artifact: scan them too
      try { hits.push(...findSanitizedEntries(readZipEntries(e.data), prefix + e.path + '!/')); } catch { /* unreadable nested zip */ }
      continue;
    }
    const text = decodeText(e);
    if (text !== null && SANITIZED_MARKER_RE.test(text)) hits.push(prefix + e.path);
  }
  return hits;
}
