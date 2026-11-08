/**
 * Genera bloques PDF ricos (esquema, endpoints, llamadas, ejemplos, pasos, parámetros, scripts)
 * a partir del .iflw de un informe de inspectBundle. Nunca lee valores de .prop:
 * los parámetros se documentan por nombre/tipo/uso (parameters.propdef) y se muestran como {{Param}}.
 */
import {
  parseIflowModel, flowComponents, orderNodes, stepTypeLabel, describeStep,
  parameterUsage, buildCallExample, adapterProps
} from './iflow-model.mjs';
import { buildDocument } from './iflow-doc-sections.mjs';

const ALIAS_RE = /sanitized\.invalid|SANITIZED_|urn:sanitized|198\.51\.100\./;

/** Un bundle limpiado con sanitize-iflow-zip contiene alias: se trata como modo privacidad. */
export function looksSanitized(report) {
  const texts = [
    ...(report.catalog?.iflwFiles || []).map((f) => f.text || ''),
    ...(report.catalog?.groovyScripts || []).map((f) => f.content || '')
  ];
  return texts.some((t) => ALIAS_RE.test(t));
}

function maskValue(v, privacy) {
  const s = String(v ?? '');
  if (!privacy) return s;
  // En modo privacidad solo se muestran placeholders {{X}}, alias saneados y valores no sensibles
  return s
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => (ALIAS_RE.test(u) || u.includes('{{') ? u : '<url oculta>'))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip.startsWith('198.51.100.') ? ip : '<ip oculta>'))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (e) => (ALIAS_RE.test(e) ? e : '<email oculto>'));
}

function kindOf(n) {
  const at = n.activityType || '';
  if (/^start/i.test(n.tag) || /^Start/.test(at)) return 'start';
  if (/^end/i.test(n.tag) || /^End/.test(at)) return 'end';
  if (/Gateway/.test(n.tag) || /Gateway|Multicast|Join/.test(at)) return 'gateway';
  if (at === 'Script') return 'script';
  if (at === 'ExternalCall' || at === 'Send') return 'call';
  if (at === 'Enricher' || at === 'Variables') return 'modifier';
  if (at === 'ProcessCallElement') return 'process';
  return 'other';
}

function parseParamDefs(report) {
  const defs = [];
  for (const f of report.catalog?.parameterFiles || []) {
    if (!/\.propdef$/i.test(f.path || f.name || '')) continue;
    const text = String(f.content || '');
    for (const m of text.matchAll(/<parameter>([\s\S]*?)<\/parameter>/g)) {
      const get = (t) => (m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
      const name = get('name').trim();
      if (name) defs.push({ name, type: get('type').trim(), required: get('isRequired').trim(), description: get('description').trim() });
    }
  }
  return defs;
}

const jsonResponseExample = (fields) => {
  const f = (fields || 'sys_id,number').split(',').map((s) => s.trim()).filter(Boolean);
  const obj = Object.fromEntries(f.map((k) => [k, `<${k}>`]));
  return JSON.stringify({ result: [obj] }, null, 2);
};

/**
 * @returns {{ available:boolean, privacy:boolean, overview:Array, architecture:Array, parameters:Array, scripts:Array, errors:Array, annexes:Array }}
 */
export function buildIflowDetailBlocks(report, options = {}) {
  const xml = report.catalog?.iflwFiles?.[0]?.text;
  const out = { available: false, privacy: false, overview: [], architecture: [], parameters: [], scripts: [], errors: [], annexes: [], document: [] };
  if (!xml) return out;
  const model = parseIflowModel(xml);
  if (!model.nodes.length) return out;
  const privacy = options.privacy ?? looksSanitized(report);
  out.available = true;
  out.privacy = privacy;
  const mv = (v) => maskValue(v, privacy);

  const comps = flowComponents(model);
  const mainComp = comps.find((c) => c.isMain) || comps[0];
  const systems = new Map();
  for (const mf of model.messageFlows) {
    const key = mf.participantId || mf.id;
    const part = model.participants.find((p) => p.id === key);
    const label = mf.systemName || part?.name || key;
    if (!systems.has(key)) systems.set(key, { label, adapters: new Set(), directions: new Set() });
    systems.get(key).adapters.add(mf.adapter);
    systems.get(key).directions.add(mf.direction);
  }

  // ---- 1. Resumen: objetivo y alcance
  const startNode = mainComp?.nodes.find((n) => /^Start/.test(n.activityType || ''));
  const trigger = startNode ? `${stepTypeLabel(startNode)}${startNode.props?.scheduleKey ? ' (' + startNode.props.scheduleKey + ')' : ''}` : 'No identificado';
  const totalSteps = model.nodes.filter((n) => n.tag !== 'subProcess').length;
  out.overview.push({ type: 'paragraph', text: `Este iFlow orquesta ${totalSteps} pasos distribuidos en ${comps.length} proceso(s) y se comunica con ${systems.size} sistema(s) externo(s) mediante ${model.messageFlows.length} canal(es) de integración.` });
  out.overview.push({ type: 'kv', key: 'Disparador', value: trigger });
  out.overview.push({ type: 'kv', key: 'Sistemas implicados', value: [...systems.values()].map((s) => `${s.label} (${[...s.adapters].join('/')})`).join(' | ') || 'Ninguno' });
  out.overview.push({ type: 'kv', key: 'Procesos', value: comps.map((c) => `${c.kindLabel}: ${c.title}`).join(' | ') });
  if (privacy) {
    out.overview.push({ type: 'callout', tone: 'private', text: 'Documento generado en MODO PRIVACIDAD: endpoints, hosts y credenciales aparecen como alias o parámetros {{Parametro}}. Los valores reales de configuración nunca se incluyen en este documento.' });
  }

  // ---- 2. Arquitectura: esquema por proceso + participantes + pasos
  out.architecture.push({ type: 'subsection', keep: 250, text: '2.1 Esquema de integración' });
  for (const c of comps) {
    const ordered = orderNodes(c.nodes, model.flows);
    const ids = new Set(ordered.map((n) => n.id));
    const nodes = ordered.map((n, i) => ({ id: n.id, label: `${i + 1}. ${n.name || stepTypeLabel(n)}`, sub: stepTypeLabel(n), kind: kindOf(n) }));
    const edges = model.flows.filter((f) => ids.has(f.from) && ids.has(f.to)).map((f) => ({ from: f.from, to: f.to, label: f.name && f.condition ? f.name : '' }));
    for (const mf of model.messageFlows) {
      if (!mf.stepId || !ids.has(mf.stepId)) continue;
      const sid = `sys:${mf.participantId || mf.id}`;
      if (!nodes.find((n) => n.id === sid)) nodes.push({ id: sid, label: mf.systemName || mf.participantId || 'Sistema', sub: mf.adapter, kind: 'system' });
      edges.push(mf.direction === 'Sender' ? { from: sid, to: mf.stepId, label: mf.adapter } : { from: mf.stepId, to: sid, label: mf.adapter });
    }
    out.architecture.push({ type: 'diagram', title: `${c.kindLabel}: ${c.title}`, nodes, edges });
  }

  out.architecture.push({ type: 'subsection', text: '2.2 Sistemas y participantes' });
  out.architecture.push({
    type: 'table',
    columns: [{ title: 'Sistema', weight: 3, bold: true }, { title: 'Adaptador', weight: 2 }, { title: 'Rol', weight: 2 }],
    rows: [...systems.values()].map((s) => [s.label, [...s.adapters].join(', '), [...s.directions].map((d) => (d === 'Sender' ? 'Origen (entrada)' : 'Destino (salida)')).join(', ')])
  });

  out.architecture.push({ type: 'subsection', text: '2.3 Detalle paso a paso' });
  for (const c of comps) {
    const rows = orderNodes(c.nodes, model.flows).map((n, i) => [String(i + 1), n.name || n.id, stepTypeLabel(n), mv(describeStep(n, model).join('\n')) || '-']);
    out.architecture.push({ type: 'subsection', keep: 110, text: `${c.kindLabel}: ${c.title}` });
    out.architecture.push({
      type: 'table', fontSize: 7.4,
      columns: [{ title: '#', weight: 0.5 }, { title: 'Paso', weight: 2.6, bold: true }, { title: 'Tipo', weight: 2.2 }, { title: 'Configuración', weight: 6 }],
      rows
    });
  }

  // ---- 3. Parámetros (nombre / tipo / uso; nunca valores)
  const defs = parseParamDefs(report);
  const usage = parameterUsage(model);
  const names = [...new Set([...defs.map((d) => d.name), ...usage.keys()])].sort();
  if (names.length) {
    out.parameters.push({
      type: 'table', fontSize: 7.4,
      columns: [{ title: 'Parámetro', weight: 3, mono: true }, { title: 'Tipo', weight: 1.4 }, { title: 'Oblig.', weight: 0.9 }, { title: 'Descripción / Uso', weight: 6 }],
      rows: names.map((nm) => {
        const d = defs.find((x) => x.name === nm);
        const uses = [...(usage.get(nm) || [])].slice(0, 4).join('; ');
        return [`{{${nm}}}`, d?.type || '-', d?.required === 'true' ? 'Sí' : d ? 'No' : '-', mv([d?.description, uses && `Usado en: ${uses}`].filter(Boolean).join(' - ')) || '-'];
      })
    });
    out.parameters.push({ type: 'paragraph', text: 'Los valores concretos de cada parámetro se configuran en el tenant y no se reproducen en este documento.' });
  }

  // ---- 4. Scripts
  const scriptSteps = model.nodes.filter((n) => n.activityType === 'Script');
  if (scriptSteps.length) {
    out.scripts.push({
      type: 'table', fontSize: 7.6,
      columns: [{ title: 'Paso', weight: 3, bold: true }, { title: 'Script', weight: 3, mono: true }, { title: 'Colección', weight: 2 }],
      rows: scriptSteps.map((n) => [n.name || n.id, n.props?.script || '-', n.props?.scriptBundleId || 'local'])
    });
  }

  // ---- 5. Errores
  const errProc = comps.filter((c) => c.isSubProcess || /exception|error/i.test(c.title));
  for (const c of errProc) {
    out.errors.push({ type: 'paragraph', text: `${c.kindLabel}: ${c.title}` });
    out.errors.push({ type: 'bullet', text: orderNodes(c.nodes, model.flows).map((n) => n.name || stepTypeLabel(n)).join(' -> ') });
  }

  // ---- Anexos: endpoints, llamadas y ejemplos
  const mfs = model.messageFlows.filter((m) => m.stepId || m.adapter);
  if (mfs.length) {
    out.annexes.push({ type: 'section', text: 'Anexo A. Endpoints y Llamadas' });
    out.annexes.push({
      type: 'table', fontSize: 7.2,
      columns: [{ title: 'Paso', weight: 2.4, bold: true }, { title: 'Sistema', weight: 2.2 }, { title: 'Adapt.', weight: 1.4 }, { title: 'Dir.', weight: 1.2 }, { title: 'Dirección / Recurso', weight: 5, mono: true }],
      rows: mfs.map((mf) => {
        const step = model.nodes.find((n) => n.id === mf.stepId);
        const p = mf.props || {};
        const addr = p.address || p.httpAddressWithoutQuery || p.QueueName_outbound || p.QueueName_inbound || p.QueueName || '-';
        return [step?.name || mf.name || mf.id, mf.systemName || mf.participantId || '-', mf.adapter || '-', mf.direction === 'Sender' ? 'Entrada' : 'Salida', mv(addr)];
      })
    });
    out.annexes.push({ type: 'section', text: 'Anexo B. Ejemplos de Llamada y Respuesta' });
    for (const mf of mfs) {
      const step = model.nodes.find((n) => n.id === mf.stepId);
      const ex = buildCallExample(mf);
      out.annexes.push({ type: 'subsection', text: `${step?.name || mf.name || mf.id} - ${mf.adapter || ''} (${mf.direction === 'Sender' ? 'entrada' : 'salida'})` });
      out.annexes.push({ type: 'code', caption: 'Solicitud', language: ex.language, text: mv(ex.text) });
      for (const note of ex.notes) out.annexes.push({ type: 'bullet', text: mv(note) });
      if (String(mf.adapter).toLowerCase() === 'servicenow') {
        out.annexes.push({ type: 'code', caption: 'Respuesta ilustrativa (datos sintéticos)', language: 'json', text: jsonResponseExample(mf.props?.sysparmfields) });
      }
      const extra = adapterProps(mf).filter(([k]) => /timeout|retry|authentication|proxy/i.test(k)).slice(0, 8);
      if (extra.length) out.annexes.push({ type: 'paragraph', text: 'Opciones de conexión: ' + extra.map(([k, v]) => `${k}=${mv(v)}`).join('; ') });
    }
  }
  out.document = buildDocument(report, model, { comps, systems, mfs, names, privacy, mv, out });
  return out;
}
