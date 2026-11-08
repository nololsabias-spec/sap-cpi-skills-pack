/**
 * Interpretación funcional de un iFlow: para cada paso explica QUÉ aporta al ciclo de negocio
 * (propósito, qué consume y qué produce) en lugar de repetir la configuración que ya se ve en
 * la herramienta de diseño.
 * Solo usa nombres (propiedades, cabeceras, scripts); nunca valores de configuración.
 */
import { parseRows } from './iflow-model.mjs';
import { mappingResource, findMappingFile, describeMappingFile } from './iflow-mappings.mjs';

const REF_RE = /\$\{(?:exchange\.)?(?:property|header)\.([A-Za-z0-9_.\-]+)/g;
const refsIn = (text) => [...new Set([...String(text || '').matchAll(REF_RE)].map((m) => m[1]))];
const uniq = (a) => [...new Set(a.filter(Boolean))];
const list = (a, max = 6) => (a.length > max ? `${a.slice(0, max).join(', ')} (+${a.length - max})` : a.join(', '));

/** Lee, solo por nombre, qué propiedades/cabeceras toca un script Groovy. */
export function scriptIO(source) {
  const s = String(source || '');
  const grab = (re) => uniq([...s.matchAll(re)].map((m) => m[1]));
  return {
    readsProps: grab(/getProperty\(\s*["']([^"']+)["']/g),
    writesProps: grab(/setProperty\(\s*["']([^"']+)["']/g),
    readsHeaders: grab(/getHeader\(\s*["']([^"']+)["']/g),
    writesHeaders: grab(/setHeader\(\s*["']([^"']+)["']/g),
    usesBody: /getBody\(/.test(s),
    setsBody: /setBody\(/.test(s)
  };
}

const SCRIPT_PURPOSES = [
  [/window|range|interval/i, 'Calcula la ventana temporal (desde/hasta) que se consultará en esta ejecución.'],
  [/json.*xml|toxml/i, 'Convierte la respuesta JSON del origen a XML para que los pasos siguientes la traten como mensaje estructurado.'],
  [/correlation|trace/i, 'Genera o propaga el identificador de correlación para poder seguir el mensaje de extremo a extremo.'],
  [/build.*(message|payload)|compose/i, 'Construye el mensaje final que se entregará al destino, con el formato y los campos que espera.'],
  [/idle|sleep|wait|delay/i, 'Introduce una espera controlada para no saturar el sistema origen.'],
  [/error|exception|mail/i, 'Prepara la información del error para notificarlo.'],
  [/valid|check/i, 'Valida el contenido antes de continuar.'],
  [/map|transform|convert/i, 'Transforma los datos al formato requerido por el siguiente paso.']
];

function findGroovy(report, fileName) {
  const base = String(fileName || '').split('/').pop();
  return (report.catalog?.groovyScripts || []).find((g) => String(g.name || g.path || '').split('/').pop() === base);
}

/**
 * @returns {{purpose:string, inputs:string, outputs:string}}
 */
export function functionalStep(node, model, report) {
  const p = node.props || {};
  const mf = model.messageFlows.find((x) => x.stepId === node.id);
  const at = node.activityType || '';
  const sys = mf ? mf.systemName || mf.participantId : '';
  let purpose = '';
  let inputs = [];
  let outputs = [];

  switch (at) {
    case 'StartTimerEvent':
      purpose = 'Arranca el ciclo de forma periódica según el planificador configurado; no depende de un mensaje entrante.';
      outputs = ['Mensaje vacío que inicia el ciclo'];
      break;
    case 'StartEvent':
      purpose = 'Punto de entrada del proceso.';
      break;
    case 'StartErrorEvent':
      purpose = 'Se activa cuando cualquier paso del proceso principal falla y no se ha controlado el error.';
      break;
    case 'Enricher': {
      const props = parseRows(p.propertyTable).map((r) => r.named.Name).filter(Boolean);
      const heads = parseRows(p.headerTable).map((r) => r.named.Name).filter(Boolean);
      const vals = [...parseRows(p.propertyTable), ...parseRows(p.headerTable)].map((r) => `${r.named.Value || ''}`);
      purpose = `Deja preparado el contexto de la ejecución: define ${props.length} propiedad(es)${heads.length ? ` y ${heads.length} cabecera(s)` : ''} que los pasos posteriores leen en lugar de repetir la lógica.`;
      const ext = uniq(vals.join(' ').match(/\{\{[^}]+\}\}/g) || []);
      inputs = uniq([...refsIn(vals.join(' ')).filter((x) => !/^\{\{/.test(x))]);
      if (ext.length) inputs.push(`${ext.length} parámetro(s) externalizado(s)`);
      outputs = [props.length ? `Propiedades: ${list(props)}` : '', heads.length ? `Cabeceras: ${list(heads)}` : ''].filter(Boolean);
      if (p.bodyType) outputs.push('Cuerpo del mensaje');
      break;
    }
    case 'Mapping':
    case 'XSLTMapping': {
      const res = mappingResource(p);
      const rec = findMappingFile(report, res);
      const n = rec ? describeMappingFile(rec).length : 0;
      purpose = `Transforma la estructura del mensaje${res ? ` aplicando el mapeo «${res}»` : ''}${n ? ` (${n} campo(s) de destino; ver sección 6)` : ' (ver sección 6)'}.`;
      inputs = ['Cuerpo (estructura de origen)'];
      outputs = ['Cuerpo (estructura de destino)'];
      break;
    }
    case 'Script': {
      const g = findGroovy(report, p.script);
      const io = g ? scriptIO(g.content || g.text || '') : null;
      const hit = SCRIPT_PURPOSES.find(([re]) => re.test(p.script || node.name || ''));
      purpose = hit ? hit[1] : 'Aplica lógica Groovy específica que las funciones estándar de configuración no cubren.';
      if (io) {
        inputs = [io.readsProps.length ? `Propiedades: ${list(io.readsProps)}` : '', io.readsHeaders.length ? `Cabeceras: ${list(io.readsHeaders)}` : '', io.usesBody ? 'Cuerpo' : ''].filter(Boolean);
        outputs = [io.writesProps.length ? `Propiedades: ${list(io.writesProps)}` : '', io.writesHeaders.length ? `Cabeceras: ${list(io.writesHeaders)}` : '', io.setsBody ? 'Cuerpo modificado' : ''].filter(Boolean);
      }
      break;
    }
    case 'ExternalCall': {
      const addr = String(mf?.props?.address || mf?.props?.httpAddressWithoutQuery || '');
      const table = (addr.match(/\/table\/([A-Za-z0-9_]+)/) || [])[1];
      purpose = `Consulta a ${sys || 'un sistema externo'}${table ? ` (recurso ${table})` : ''} y sustituye el cuerpo del mensaje por la respuesta. Es síncrono: el flujo espera el resultado.`;
      inputs = refsIn(JSON.stringify(mf?.props || {})).map((r) => `Propiedad/cabecera ${r}`);
      outputs = ['Respuesta del sistema como cuerpo'];
      break;
    }
    case 'Send':
      purpose = `Entrega el resultado a ${sys || 'el destino'} sin esperar respuesta de negocio; a partir de aquí el consumo es responsabilidad del destino.`;
      inputs = ['Cuerpo del mensaje'];
      break;
    case 'Splitter':
      purpose = 'Divide el mensaje en elementos independientes para que cada uno se procese y entregue por separado.';
      inputs = ['Mensaje con varios elementos'];
      outputs = ['Un mensaje por elemento'];
      break;
    case 'Gather':
      purpose = 'Reúne los resultados de las ramas anteriores en un único mensaje.';
      inputs = ['Mensajes de cada rama'];
      outputs = ['Mensaje combinado'];
      break;
    case 'Multicast':
    case 'ParallelGateway':
      purpose = `Lanza ${node.outgoing?.length || 'varias'} ramas a la vez con el mismo mensaje de partida.`;
      break;
    case 'Join':
      purpose = 'Espera a que terminen todas las ramas paralelas antes de continuar.';
      break;
    case 'ExclusiveGateway':
      purpose = 'Decide por qué camino continúa el flujo evaluando condiciones; solo se sigue una ruta.';
      inputs = uniq(node.outgoing.flatMap((f) => refsIn(f.condition)).map((r) => `Propiedad/cabecera ${r}`));
      break;
    case 'Variables': {
      const vars = parseRows(p.variable).map((r) => r.cells[0]).filter(Boolean);
      purpose = `Guarda ${list(vars) || 'valores'} entre ejecuciones del iFlow para que la siguiente ejecución sepa desde dónde continuar.`;
      outputs = vars.map((v) => `Variable ${v}`);
      break;
    }
    case 'DBstorage': {
      const op = String(p.operation || '').toLowerCase();
      const ext = String(p.storageName || '').match(/\{\{[^}]+\}\}/);
      const store = ext ? `el Data Store ${ext[0]}` : 'el Data Store';
      if (op === 'get') {
        purpose = `Recupera una entrada de ${store} para reutilizar un resultado ya calculado${p.delete === 'true' ? ' y la elimina tras leerla' : ''}${p.stopOnMissingEntry === 'true' ? '; falla si la entrada no existe' : '; si no existe, el flujo continúa'}.`;
        outputs = ['Cuerpo con la entrada recuperada'];
      } else if (op === 'put') {
        purpose = `Guarda el mensaje actual en ${store}${p.includeMessageHeaders === 'true' ? ' junto con sus cabeceras' : ''} para consultarlo en ejecuciones posteriores${p.expire ? ` (caduca a los ${p.expire} día(s))` : ''}.`;
        inputs = ['Cuerpo del mensaje'];
      } else if (op === 'delete') {
        purpose = `Elimina una entrada de ${store}.`;
      } else {
        purpose = `Opera sobre ${store}${op ? ` (${op})` : ''}.`;
      }
      break;
    }
    case 'ProcessCallElement':
      purpose = `Delega en el proceso local «${p.processId || ''}» para reutilizar su lógica.`;
      break;
    case 'EndEvent':
    case 'EndMessageEvent':
      purpose = 'Termina el procesamiento de este camino.';
      break;
    case 'EndErrorEvent':
      purpose = 'Finaliza marcando el mensaje como fallido para que quede visible en el monitor.';
      break;
    default:
      purpose = node.tag === 'endEvent' ? 'Termina el procesamiento de este camino.' : node.tag === 'startEvent' ? 'Punto de entrada del proceso.' : 'Paso de proceso.';
  }
  return { purpose, inputs: inputs.filter(Boolean).join('; ') || '-', outputs: outputs.filter(Boolean).join('; ') || '-' };
}
