#!/usr/bin/env node
/**
 * SAP CPI Graphical Message Mapping (.mmap / <xiObj>) Generator & Validator
 * - Generates 100% compliant SAP CPI Graphical Message Mapping (.mmap) XML files
 *   linking Source XSD and Target XSD schemas in `src/main/resources/xsd`.
 * - Automatically synthesizes parent container bricks (`Constant`) for nested target paths.
 * - Supports Source-to-Target XPath mappings (`Src`), Constants (`const`),
 *   Exchange Headers (`getHeader`), and Exchange Properties (`getProperty`).
 * - Validates existing `.mmap` files against SAP CPI XI7.1 Message Mapping rules.
 *
 * Usage:
 *   node build-mmap.mjs --demo [--json]
 *   node build-mmap.mjs --validate <file.mmap> [--json]
 *   node build-mmap.mjs --source-xsd <Source.xsd:Root> --target-xsd <Target.xsd:Root> \
 *     [--map /TargetRoot/a=/SourceRoot/b] [--const /TargetRoot/c=VALOR] \
 *     [--header /TargetRoot/h=CamelHttpMethod] [--property /TargetRoot/p=PropName] \
 *     --out <MappingName.mmap>
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDstBrickXml(targetPath, innerArgXml) {
  return `<brick gid="0" path="${escapeXml(targetPath)}" type="Dst"><viewData x="200" y="40"/><arg>${innerArgXml}</arg><group/></brick>`;
}

function buildConstArgXml(val) {
  return `<brick fname="const" fns="dflt" type="Func"><viewData x="50" y="40"/><bindings><param name="value"><value>${escapeXml(val)}</value></param></bindings></brick>`;
}

function buildSrcArgXml(sourcePath) {
  return `<brick gid="0" path="${escapeXml(sourcePath)}" type="Src"><viewData x="50" y="40"/></brick>`;
}

function buildHeaderOrPropArgXml(fnName, keyName) {
  return `<brick fname="${escapeXml(fnName)}" fns="dflt" type="Func"><viewData x="50" y="40"/><arg>${buildConstArgXml(keyName)}</arg></brick>`;
}

/**
 * Generates a SAP CPI Graphical Message Mapping (.mmap) XML string.
 * @param {object} spec
 * @param {string} spec.sourceXsd - File name of source XSD in src/main/resources/xsd (e.g. 'Source.xsd')
 * @param {string} spec.sourceRoot - Root element name in source XSD (e.g. 'root')
 * @param {string} spec.targetXsd - File name of target XSD in src/main/resources/xsd (e.g. 'Target.xsd')
 * @param {string} spec.targetRoot - Root element name in target XSD (e.g. 'LogRoot')
 * @param {Array<{target: string, source?: string, constant?: string, header?: string, property?: string}>} spec.mappings
 * @returns {string}
 */
/**
 * Splits "<file.xsd>:<Root>" on the LAST colon so Windows paths (C:\\dir\\a.xsd:Root) keep their drive letter.
 * @returns {[string, string|undefined]}
 */
export function splitXsdSpec(spec) {
  const s = String(spec || '');
  const i = s.lastIndexOf(':');
  // "C:\\a.xsd" (colon right after a drive letter) has no root part.
  if (i === -1 || (i === 1 && /^[A-Za-z]$/.test(s[0]))) return [s, undefined];
  return [s.slice(0, i), s.slice(i + 1) || undefined];
}

/** Parses "/Target/path=value". Returns null when malformed (no "=", empty sides, relative target). */
export function parseMappingArg(arg) {
  if (typeof arg !== 'string') return null;
  const eq = arg.indexOf('=');
  if (eq <= 0) return null;
  const target = arg.slice(0, eq).trim();
  const value = arg.slice(eq + 1);
  if (!target.startsWith('/') || target.length < 2 || value === '') return null;
  return { target, value };
}

export function generateMmapXml(spec) {
  const sourceXsd = path.basename(spec.sourceXsd || 'Source.xsd');
  const sourceRoot = spec.sourceRoot || 'root';
  const targetXsd = path.basename(spec.targetXsd || 'Target.xsd');
  const targetRoot = spec.targetRoot || 'TargetRoot';
  const mappings = Array.isArray(spec.mappings) ? spec.mappings : [];

  const textObjId = crypto.randomBytes(16).toString('hex');
  const modifAtLong = Date.now();

  // Ensure parent container paths exist for nested target nodes (e.g., /Root/parent/child requires /Root/parent)
  const definedTargetPaths = new Set(mappings.map((m) => m.target));
  const finalBricks = [];
  const emittedContainers = new Set();

  for (const m of mappings) {
    const cleanTarget = (m.target || '').trim();
    if (!cleanTarget.startsWith('/')) continue;

    // Check intermediate segments between /TargetRoot and leaf
    const segments = cleanTarget.split('/').filter(Boolean); // e.g. ['LogRoot', 'request', 'headers', 'user_agent']
    if (segments.length > 2) {
      let currentPath = `/${segments[0]}`;
      for (let i = 1; i < segments.length - 1; i++) {
        currentPath += `/${segments[i]}`;
        if (!definedTargetPaths.has(currentPath) && !emittedContainers.has(currentPath)) {
          emittedContainers.add(currentPath);
          finalBricks.push(buildDstBrickXml(currentPath, buildConstArgXml('Constant')));
        }
      }
    }

    let argXml = '';
    if (m.source) {
      argXml = buildSrcArgXml(m.source);
    } else if (m.header) {
      argXml = buildHeaderOrPropArgXml('getHeader', m.header);
    } else if (m.property) {
      argXml = buildHeaderOrPropArgXml('getProperty', m.property);
    } else {
      argXml = buildConstArgXml(m.constant ?? '');
    }

    finalBricks.push(buildDstBrickXml(cleanTarget, argXml));
  }

  return `<xiObj xmlns="urn:sap-com:xi"><idInfo xmlns="" VID="01"><vc caption="LOCAL" sp="-1" swcGuid="00000000000000000000000000000000" vcType="S"><clCxt consider="A"/></vc><key typeID="XI_TRAFO" version=""/><version>1.0</version></idInfo><documentation xmlns=""><description/></documentation><generic xmlns=""><admInf><modifBy/><modifAt></modifAt><modifAtLong>${modifAtLong}</modifAtLong><owner/></admInf><lnks><lnkRole kpos="1" role="TARGET_IFR_MESS"><lnk rMode="R"><key typeID="xsd" version="1.1"><elem>${escapeXml(targetXsd)}</elem><elem>src/main/resources/xsd</elem><elem>${escapeXml(targetRoot)}</elem></key></lnk></lnkRole><lnkRole kpos="1" role="SOURCE_IFR_MESS"><lnk rMode="R"><key typeID="xsd" version="1.1"><elem>${escapeXml(sourceXsd)}</elem><elem>src/main/resources/xsd</elem><elem>${escapeXml(sourceRoot)}</elem></key></lnk></lnkRole></lnks><textInfo loadedL="EN"><textObj id="${textObjId}" masterL="EN" type="0"><texts lang="EN"><text label=""/></texts></textObj></textInfo></generic><AdditionalProperties xmlns=""><Property Applicable="BOTH"><PropertyName>externalNameSpace</PropertyName><PropertyValue>RESOLVED</PropertyValue></Property><Property Applicable="BOTH"><PropertyName>choiceOccurrence</PropertyName><PropertyValue>RESOLVED</PropertyValue></Property><Property Applicable="BOTH"><PropertyName>groupsOccurrence</PropertyName><PropertyValue>RESOLVED</PropertyValue></Property></AdditionalProperties><content xmlns=""><tr:XiTrafo xmlns:tr="urn:sap-com:xi:mapping:xitrafo"><tr:MetaData><mappingtool version="XI7.1"><project version="XI7.1"><libstorage><entry name="usernamespace"><functionstorage version="XI7.1"><key><key typeID=""><elem/><elem/></key></key><classname/><package/><imports/><globals><javaText/></globals><init><functionmodel><signature cacheType="0"/><name/><key/><tab/><title/><uiTitle/><implementation type="udf"><javaText/></implementation></functionmodel></init><cleanup><javaText/></cleanup><usedjars/></functionstorage></entry></libstorage><transformation>${finalBricks.join('')}</transformation><testData><instances/></testData><ViewState></ViewState><pcont/></project></mappingtool></tr:MetaData><tr:ByteCodeJar/><tr:SourceStructure/><tr:TargetStructure/><tr:Multiplicity>1:1</tr:Multiplicity><tr:SourceParameters><tr:Parameter><tr:Position>1</tr:Position><tr:Minoccurs>1</tr:Minoccurs><tr:Maxoccurs>1</tr:Maxoccurs></tr:Parameter></tr:SourceParameters><tr:TargetParameters><tr:Parameter><tr:Position>1</tr:Position><tr:Minoccurs>1</tr:Minoccurs><tr:Maxoccurs>1</tr:Maxoccurs></tr:Parameter></tr:TargetParameters></tr:XiTrafo></content></xiObj>`;
}

/**
 * Validates a SAP CPI Graphical Message Mapping (.mmap) XML string.
 */
export function validateMmapForSapCpi(mmapContent) {
  const errors = [];
  const warnings = [];
  const trimmed = (mmapContent || '').trim();

  if (!trimmed) {
    return { valid: false, brickCount: 0, errors: ['El archivo .mmap está vacío.'], warnings: [] };
  }

  if (!/<xiObj\b[^>]*xmlns="urn:sap-com:xi"/i.test(trimmed)) {
    errors.push('Falta el nodo raíz `<xiObj xmlns="urn:sap-com:xi">` requerido por SAP CPI Message Mapping.');
  }

  const targetRoleMatch = trimmed.match(/<lnkRole\b[^>]*role="TARGET_IFR_MESS"[\s\S]*?<\/lnkRole>/i);
  const sourceRoleMatch = trimmed.match(/<lnkRole\b[^>]*role="SOURCE_IFR_MESS"[\s\S]*?<\/lnkRole>/i);

  let sourceSchema = null;
  let targetSchema = null;

  if (!sourceRoleMatch) {
    errors.push('Falta `<lnkRole role="SOURCE_IFR_MESS">` con la referencia al esquema XSD de origen.');
  } else {
    const elems = [...sourceRoleMatch[0].matchAll(/<elem>([^<]+)<\/elem>/g)].map((m) => m[1]);
    sourceSchema = { xsd: elems[0] || null, folder: elems[1] || null, rootElement: elems[2] || null };
    if (!sourceSchema.xsd || !sourceSchema.rootElement) {
      errors.push('La referencia `SOURCE_IFR_MESS` debe incluir nombre del `.xsd`, carpeta (`src/main/resources/xsd`) y elemento raíz.');
    }
  }

  if (!targetRoleMatch) {
    errors.push('Falta `<lnkRole role="TARGET_IFR_MESS">` con la referencia al esquema XSD de destino.');
  } else {
    const elems = [...targetRoleMatch[0].matchAll(/<elem>([^<]+)<\/elem>/g)].map((m) => m[1]);
    targetSchema = { xsd: elems[0] || null, folder: elems[1] || null, rootElement: elems[2] || null };
    if (!targetSchema.xsd || !targetSchema.rootElement) {
      errors.push('La referencia `TARGET_IFR_MESS` debe incluir nombre del `.xsd`, carpeta (`src/main/resources/xsd`) y elemento raíz.');
    }
  }

  if (!/<tr:XiTrafo\b[^>]*xmlns:tr="urn:sap-com:xi:mapping:xitrafo"/i.test(trimmed)) {
    errors.push('Falta el contenedor `<tr:XiTrafo xmlns:tr="urn:sap-com:xi:mapping:xitrafo">`.');
  }

  const dstPaths = [...trimmed.matchAll(/<brick\b[^>]*path="([^"]+)"[^>]*type="Dst"/g)].map((m) => m[1]);
  if (dstPaths.length === 0) {
    warnings.push('El archivo `.mmap` no define ningún `<brick type="Dst">` en `<transformation>`.');
  }

  const dstSet = new Set(dstPaths);
  for (const p of dstPaths) {
    const segs = p.split('/').filter(Boolean);
    if (segs.length > 2) {
      let parentPath = `/${segs[0]}`;
      for (let i = 1; i < segs.length - 1; i++) {
        parentPath += `/${segs[i]}`;
        if (!dstSet.has(parentPath)) {
          warnings.push(
            `El nodo anidado \`${p}\` no tiene instanciado su contenedor padre \`${parentPath}\` como \`<brick type="Dst">\` (en SAP CPI Message Mapping los contenedores padre requieren un brick Constant o mapeo padre para generarse en el XML de salida).`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    brickCount: dstPaths.length,
    sourceSchema,
    targetSchema,
    errors,
    warnings
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso 1 (Demo):       node build-mmap.mjs --demo [--json]');
    console.log('Uso 2 (Validar):    node build-mmap.mjs --validate <archivo.mmap> [--json]');
    console.log('Uso 3 (Generar):    node build-mmap.mjs --source-xsd <Origen.xsd:Root> --target-xsd <Destino.xsd:Root> [--map /Dest/a=/Orig/b] [--const /Dest/c=VAL] [--header /Dest/h=Hdr] [--property /Dest/p=Prop] --out <Mapeo.mmap>');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');
  const fail = (msg) => {
    globalThis.console.error(`[ERROR] ${msg}`);
    process.exit(2);
  };
  const VALUE_FLAGS = ['--validate', '--source-xsd', '--target-xsd', '--map', '--const', '--header', '--property', '--out'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.includes(a)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`${a} requiere un valor.`);
      i++;
    } else if (!['--json', '--demo'].includes(a)) {
      fail(`Argumento desconocido: ${a}. Usa --help.`);
    }
  }

  if (args.includes('--validate')) {
    const valIdx = args.indexOf('--validate');
    const filePath = path.resolve(args[valIdx + 1]);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      globalThis.console.error(`[ERROR] --validate: no existe el archivo ${args[valIdx + 1]}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const res = validateMmapForSapCpi(content);
    if (jsonFlag) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`=== SAP CPI GRAPHICAL MESSAGE MAPPING (.mmap) VALIDATOR ===`);
      console.log(`Estado: ${res.valid ? 'VÁLIDO' : 'INVÁLIDO'} | Bricks Dst: ${res.brickCount}`);
      console.log(`Origen: ${res.sourceSchema?.xsd} (${res.sourceSchema?.rootElement}) -> Destino: ${res.targetSchema?.xsd} (${res.targetSchema?.rootElement})`);
      res.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
      res.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
    process.exit(res.valid ? 0 : 1);
  }

  if (args.includes('--demo')) {
    const demoXml = generateMmapXml({
      sourceXsd: 'OrderInput.xsd',
      sourceRoot: 'OrderRequest',
      targetXsd: 'CanonicalOrder.xsd',
      targetRoot: 'CanonicalOrder',
      mappings: [
        { target: '/CanonicalOrder/orderId', source: '/OrderRequest/id' },
        { target: '/CanonicalOrder/sourceSystem', constant: 'SAP-CPI' },
        { target: '/CanonicalOrder/metadata/httpMethod', header: 'CamelHttpMethod' },
        { target: '/CanonicalOrder/metadata/correlationId', property: 'SAP_MplCorrelationId' }
      ]
    });
    const res = validateMmapForSapCpi(demoXml);
    if (jsonFlag) {
      console.log(JSON.stringify({ ...res, sampleLength: demoXml.length }, null, 2));
    } else {
      console.log(`Demo .mmap generado y validado (${res.brickCount} bricks, contenedor /CanonicalOrder/metadata autogenerado).`);
    }
    process.exit(res.valid ? 0 : 1);
  }

  const getOpt = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const srcSpec = getOpt('--source-xsd');
  const tgtSpec = getOpt('--target-xsd');
  if (!srcSpec || !tgtSpec) fail('Faltan --source-xsd <Origen.xsd:Root> y/o --target-xsd <Destino.xsd:Root>.');
  const [sourceXsd, sourceRoot] = splitXsdSpec(srcSpec);
  const [targetXsd, targetRoot] = splitXsdSpec(tgtSpec);
  if (!sourceRoot || !targetRoot) fail('Indica el elemento raíz tras ":" (p. ej. Origen.xsd:Order).');
  const outPath = getOpt('--out');

  const mappings = [];
  const KIND = { '--map': 'source', '--const': 'constant', '--header': 'header', '--property': 'property' };
  for (let i = 0; i < args.length; i++) {
    const kind = KIND[args[i]];
    if (!kind) continue;
    const m = parseMappingArg(args[i + 1]);
    if (!m) fail(`${args[i]} mal formado: "${args[i + 1]}". Formato: /Destino/campo=${kind === 'source' ? '/Origen/campo' : 'VALOR'}`);
    if (kind === 'source' && !m.value.startsWith('/')) fail(`${args[i]}: la ruta de origen debe ser absoluta (/Root/...): "${m.value}"`);
    mappings.push({ target: m.target, [kind]: m.value });
    i++;
  }
  if (!mappings.length) fail('No hay ninguna correspondencia (--map/--const/--header/--property): el .mmap quedaría vacío.');

  const mmapXml = generateMmapXml({ sourceXsd, sourceRoot, targetXsd, targetRoot, mappings });
  const validation = validateMmapForSapCpi(mmapXml);

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), mmapXml, 'utf8');
    console.log(`Archivo .mmap generado y validado (${validation.brickCount} bricks) en: ${path.resolve(outPath)}`);
  } else {
    console.log(mmapXml);
  }
  process.exit(validation.valid ? 0 : 1);
}
