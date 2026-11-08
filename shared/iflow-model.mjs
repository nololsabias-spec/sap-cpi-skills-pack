/**
 * Modelo ligero de un .iflw (BPMN2 de SAP Cloud Integration) para documentación técnica.
 *
 * Extrae procesos, pasos, flujos de secuencia, canales (message flows) y sus propiedades,
 * sin dependencias externas. Nunca lee valores de `.prop`: los parámetros externalizados
 * se muestran solo como {{Nombre}}.
 */

const ENTITY = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
export function decodeXml(s) {
  return String(s ?? '').replace(/&(?:lt|gt|quot|apos|amp);/g, (m) => ENTITY[m]);
}

function attr(src, name) {
  const m = src.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"'));
  return m ? decodeXml(m[1]) : undefined;
}

function readProps(body) {
  const props = {};
  const re = /<key>([^<]*)<\/key>\s*(?:<value\/>|<value>([\s\S]*?)<\/value>)/g;
  let m;
  while ((m = re.exec(body))) {
    if (!(m[1] in props)) props[m[1]] = decodeXml(m[2] ?? '');
  }
  return props;
}

const NODE_TAGS = 'startEvent|endEvent|callActivity|serviceTask|exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|subProcess|intermediateCatchEvent|intermediateThrowEvent|boundaryEvent';

/** Tipos de paso en español (activityType de CPI -> etiqueta). */
export const STEP_TYPE_LABELS = {
  StartEvent: 'Inicio',
  StartTimerEvent: 'Inicio por temporizador',
  StartErrorEvent: 'Inicio de error',
  EndEvent: 'Fin',
  EndErrorEvent: 'Fin con error',
  EndMessageEvent: 'Fin con mensaje',
  ErrorEventSubProcessTemplate: 'Subproceso de excepción',
  ExternalCall: 'Llamada externa (Request-Reply)',
  Send: 'Envío (Send)',
  Script: 'Script Groovy/JS',
  Enricher: 'Content Modifier',
  ExclusiveGateway: 'Router (XOR)',
  ParallelGateway: 'Gateway paralelo',
  Multicast: 'Multicast paralelo',
  Join: 'Join',
  Splitter: 'Splitter',
  Gather: 'Gather',
  Variables: 'Escritura de variables',
  ProcessCallElement: 'Llamada a proceso local',
  Mapping: 'Message Mapping',
  XSLTMapping: 'XSLT Mapping',
  Filter: 'Filter',
  Aggregator: 'Aggregator',
  JsonToXmlConverter: 'Conversor JSON a XML',
  XmlToJsonConverter: 'Conversor XML a JSON',
  Encoder: 'Encoder',
  Decoder: 'Decoder',
  Validator: 'Validador XML'
};

export function stepTypeLabel(node) {
  return STEP_TYPE_LABELS[node.activityType] || (node.tag === 'endEvent' ? 'Fin' : node.tag === 'startEvent' ? 'Inicio' : node.activityType || node.tag);
}

/** Filas `<row><cell ...>` de las tablas del Content Modifier / Variables. */
export function parseRows(raw) {
  const rows = [];
  const xml = String(raw || '');
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const named = {};
    const cellRe = /<cell(?:\s+id='([^']*)')?>([\s\S]*?)<\/cell>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const v = decodeXml(cm[2]);
      cells.push(v);
      if (cm[1]) named[cm[1]] = v;
    }
    rows.push({ cells, named });
  }
  return rows;
}

/**
 * @param {string} xml contenido del .iflw
 */
export function parseIflowModel(xml) {
  const text = String(xml || '');
  const model = { participants: [], processes: [], nodes: [], flows: [], messageFlows: [] };

  for (const m of text.matchAll(/<bpmn2:participant\b([^>]*?)\/?>/g)) {
    const a = m[1];
    model.participants.push({
      id: attr(a, 'id'),
      name: attr(a, 'name'),
      type: attr(a, 'ifl:type'),
      processRef: attr(a, 'processRef')
    });
  }

  // Recorrido secuencial con pila de procesos/subprocesos
  const tokenRe = new RegExp(
    '<(/?)bpmn2:(process|subProcess|' + NODE_TAGS + '|sequenceFlow|messageFlow)\\b([^>]*?)(/?)>',
    'g'
  );
  const stack = [];
  let match;
  let last = null; // último nodo abierto (para leer su cuerpo)
  const openNodes = [];
  const bodies = [];
  while ((match = tokenRe.exec(text))) {
    const closing = match[1] === '/';
    const tag = match[2];
    const attrs = match[3];
    const selfClose = match[4] === '/';
    const idx = match.index;

    if (last) {
      bodies.push({ node: last, from: last.__bodyStart, to: idx });
      last = null;
    }

    if (tag === 'process' || tag === 'subProcess') {
      if (closing) {
        stack.pop();
        if (tag === 'subProcess') {
          // el subproceso se cierra: su cuerpo ya se acumuló en los nodos hijos
        }
      } else {
        const entry = { id: attr(attrs, 'id'), name: attr(attrs, 'name'), tag };
        stack.push(entry);
        const node = {
          id: entry.id, tag, name: entry.name, processId: stack[0]?.id,
          parentId: stack.length > 1 ? stack[stack.length - 2].id : null,
          props: {}, activityType: undefined, outgoing: [], incoming: []
        };
        if (tag === 'process') {
          model.processes.push({ id: entry.id, name: entry.name, props: {} });
          node.__process = true;
        } else {
          model.nodes.push(node);
        }
        node.__bodyStart = idx + match[0].length;
        last = node;
        if (selfClose) { stack.pop(); }
      }
      continue;
    }

    if (closing) continue;

    if (tag === 'sequenceFlow') {
      model.flows.push({
        id: attr(attrs, 'id'), name: attr(attrs, 'name'),
        from: attr(attrs, 'sourceRef'), to: attr(attrs, 'targetRef'),
        condition: undefined, flowIndex: idx
      });
      continue;
    }
    if (tag === 'messageFlow') {
      model.messageFlows.push({
        id: attr(attrs, 'id'), name: attr(attrs, 'name'),
        from: attr(attrs, 'sourceRef'), to: attr(attrs, 'targetRef'), bodyStart: idx + match[0].length
      });
      continue;
    }

    const node = {
      id: attr(attrs, 'id'), tag, name: attr(attrs, 'name'), processId: stack[0]?.id,
      parentId: stack.length ? stack[stack.length - 1].id : null,
      props: {}, activityType: undefined, outgoing: [], incoming: []
    };
    model.nodes.push(node);
    node.__bodyStart = idx + match[0].length;
    last = node;
    openNodes.push(node);
  }

  // Propiedades de cada nodo = su cuerpo hasta el siguiente token
  for (const b of bodies) {
    const body = text.slice(b.from, b.to);
    if (b.node.__process) {
      const p = model.processes.find((x) => x.id === b.node.id);
      if (p) p.props = readProps(body);
      continue;
    }
    b.node.props = readProps(body);
    b.node.activityType = b.node.props.activityType;
  }
  for (const n of model.nodes) { delete n.__bodyStart; }

  // Condiciones de los flujos (<conditionExpression> dentro del sequenceFlow)
  const flowRe = /<bpmn2:sequenceFlow\b[^>]*?(?:\/>|>([\s\S]*?)<\/bpmn2:sequenceFlow>)/g;
  let fm;
  while ((fm = flowRe.exec(text))) {
    const id = attr(fm[0], 'id');
    const cond = fm[1] && fm[1].match(/<bpmn2:conditionExpression[^>]*>([\s\S]*?)<\/bpmn2:conditionExpression>/);
    if (cond) {
      const f = model.flows.find((x) => x.id === id);
      if (f) f.condition = decodeXml(cond[1]).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    }
  }

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const f of model.flows) {
    byId.get(f.from)?.outgoing.push(f);
    byId.get(f.to)?.incoming.push(f);
  }

  // Canales: propiedades del adaptador
  const partById = new Map(model.participants.map((p) => [p.id, p]));
  for (const mf of model.messageFlows) {
    const end = text.indexOf('</bpmn2:messageFlow>', mf.bodyStart);
    const props = readProps(text.slice(mf.bodyStart, end === -1 ? undefined : end));
    delete mf.bodyStart;
    mf.props = props;
    mf.adapter = props.ComponentType || props.Name || 'Adapter';
    mf.direction = props.direction || (partById.get(mf.from)?.type === 'EndpointSender' ? 'Sender' : 'Receiver');
    mf.systemName = props.system || partById.get(mf.direction === 'Sender' ? mf.from : mf.to)?.name || '';
    mf.stepId = mf.direction === 'Sender' ? mf.to : mf.from;
    mf.participantId = mf.direction === 'Sender' ? mf.from : mf.to;
  }

  return model;
}

/** Componentes conexos por flujos de secuencia (un diagrama por proceso/subproceso). */
export function flowComponents(model) {
  const ids = model.nodes.filter((n) => n.tag !== 'subProcess').map((n) => n.id);
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const f of model.flows) {
    if (parent.has(f.from) && parent.has(f.to)) parent.set(find(f.from), find(f.to));
  }
  const groups = new Map();
  for (const n of model.nodes) {
    if (n.tag === 'subProcess') continue;
    const root = find(n.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const procById = new Map(model.processes.map((p) => [p.id, p]));
  return [...groups.values()].map((nodes) => {
    const first = nodes[0];
    const sub = first.parentId && byId.get(first.parentId)?.tag === 'subProcess' ? byId.get(first.parentId) : null;
    const proc = procById.get(first.processId);
    const title = sub
      ? `${sub.name || sub.id} (dentro de ${proc?.name || proc?.id})`
      : proc?.name || first.processId || 'Proceso';
    const isMain = !sub && proc?.props?.processType !== 'directCall';
    return { title, nodes, processId: first.processId, isSubProcess: !!sub, isMain, kindLabel: sub ? 'Subproceso' : proc?.props?.processType === 'directCall' ? 'Proceso local' : 'Proceso principal' };
  }).sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/** Orden topológico simple (los ciclos se ignoran cortando aristas hacia atrás). */
export function orderNodes(nodes, flows) {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const f of flows) {
    if (ids.has(f.from) && ids.has(f.to)) { out.get(f.from).push(f.to); indeg.set(f.to, indeg.get(f.to) + 1); }
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const t of out.get(id)) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) <= 0 && !seen.has(t)) queue.push(t);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return order.map((id) => byId.get(id));
}

const NOISE = new Set([
  'ComponentNS', 'ComponentSWCVName', 'ComponentSWCVId', 'componentVersion', 'cmdVariantUri', 'TransportProtocolVersion',
  'MessageProtocolVersion', 'Vendor', 'Name', 'ComponentType', 'direction', 'system'
]);

export function adapterProps(mf) {
  return Object.entries(mf.props).filter(([k, v]) => !NOISE.has(k) && v !== '' && v != null);
}

/** Descripción corta de un paso para la tabla de flujo. */
export function describeStep(node, model) {
  const p = node.props || {};
  const parts = [];
  switch (node.activityType) {
    case 'Script':
      parts.push(`${p.script || '(script)'}${p.scriptBundleId ? ' - colección ' + p.scriptBundleId : ''}`);
      break;
    case 'Enricher': {
      const rows = parseRows(p.propertyTable);
      const hrows = parseRows(p.headerTable);
      for (const r of rows) parts.push(`Propiedad ${r.named.Name || '?'} = ${r.named.Value || r.named.Default || ''} [${r.named.Type || ''}]`);
      for (const r of hrows) parts.push(`Cabecera ${r.named.Name || '?'} = ${r.named.Value || r.named.Default || ''} [${r.named.Type || ''}]`);
      if (p.bodyType) parts.push(`Cuerpo: ${p.bodyType}${p.wrapContent ? ' (plantilla de mensaje)' : ''}`);
      break;
    }
    case 'Splitter':
      parts.push(`${p.splitType || 'Splitter'} (${p.exprType || '?'} ${p.splitExprValue || ''}); streaming=${p.Streaming}; hilos=${p.SplitterThreads || '-'}; paralelo=${p.ParallelProcessing}; timeout=${p.timeOut || '-'}s`);
      break;
    case 'Gather':
      parts.push(`${p.messageType || ''}; ${p.aggregationAlgorithm || ''}`.trim());
      break;
    case 'Variables': {
      for (const r of parseRows(p.variable)) {
        parts.push(`Variable ${r.cells[0]} <- ${r.cells[1]}:${r.cells[3]} (${r.cells[4] || 'local'}${p.encrypt === 'true' ? ', cifrada' : ''}${p.expire ? ', expira ' + p.expire + ' d' : ''})`);
      }
      break;
    }
    case 'ProcessCallElement':
      parts.push(`Llama a ${p.processId}`);
      break;
    case 'ExclusiveGateway':
      for (const f of node.outgoing) parts.push(`${f.name || f.id}${f.condition ? ': ' + f.condition : ' (ruta por defecto)'}`);
      break;
    case 'StartTimerEvent':
      parts.push(`Programación: ${p.scheduleKey || '(planificador)'}`);
      break;
    case 'ExternalCall':
    case 'Send': {
      const mf = model.messageFlows.find((x) => x.stepId === node.id);
      if (mf) parts.push(`${mf.adapter} -> ${mf.systemName || mf.participantId}`);
      break;
    }
    case 'Multicast':
    case 'ParallelGateway':
      for (const f of node.outgoing) parts.push(`Rama: ${f.name || f.id}`);
      break;
    default:
      break;
  }
  return parts;
}

/** Referencias {{Parametro}} utilizadas por cada paso/canal. */
export function parameterUsage(model) {
  const usage = new Map();
  const add = (name, where) => {
    if (!usage.has(name)) usage.set(name, new Set());
    usage.get(name).add(where);
  };
  const scan = (obj, where) => {
    for (const v of Object.values(obj || {})) {
      for (const m of String(v).matchAll(/\{\{([A-Za-z0-9_.\-]+)\}\}/g)) add(m[1], where);
    }
  };
  for (const n of model.nodes) scan(n.props, n.name || n.id);
  for (const mf of model.messageFlows) scan(mf.props, `Canal ${mf.adapter} (${mf.systemName || mf.name || mf.id})`);
  return usage;
}

/**
 * Llamada de ejemplo de un canal. No incluye credenciales ni valores reales:
 * las direcciones externalizadas se muestran como {{Parametro}}.
 */
export function buildCallExample(mf) {
  const p = mf.props;
  const adapter = String(mf.adapter || '').toLowerCase();
  const cred = p.credentials || p.credentialName || p.alias || '';
  const lines = [];
  const notes = [];
  let language = 'http';

  if (adapter === 'servicenow') {
    const base = p.address || '{{Instancia}}';
    const host = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    const ver = p.version ? p.version + '/' : 'now/';
    const table = p.tableName || '{tabla}';
    const q = [];
    if (p.queryManual) q.push('sysparm_query=' + p.queryManual);
    if (p.sysparmfields) q.push('sysparm_fields=' + p.sysparmfields);
    if (p.sysparmlimit) q.push('sysparm_limit=' + p.sysparmlimit);
    if (p.sysparmoffset) q.push('sysparm_offset=' + p.sysparmoffset);
    if (p.sysparmdisplayvalue) q.push('sysparm_display_value=' + p.sysparmdisplayvalue);
    if (p.sysparmexcludereferencelink) q.push('sysparm_exclude_reference_link=' + p.sysparmexcludereferencelink);
    const isQuery = /QUERY|GET|RETRIEVE/i.test(p.OperationName || 'GET');
    lines.push(`${isQuery ? 'GET' : (p.OperationName || 'POST')} ${host}/api/${ver}table/${table}${q.length ? '?' + q.join('&') : ''}`);
    lines.push(`Accept: ${p.payloadFormatResponse === 'xml' ? 'application/xml' : 'application/json'}`);
    lines.push(`Authorization: ${String(p.authentication || 'basic').toLowerCase() === 'basic' ? 'Basic <credencial ' + (cred || 'del tenant') + '>' : 'Bearer <token OAuth2>'}`);
    notes.push('Tabla de ServiceNow: ' + table);
  } else if (adapter === 'http' || adapter === 'https') {
    const url = p.httpAddressWithoutQuery || p.address || '{{URL}}';
    const method = p.httpMethod || (mf.direction === 'Sender' ? 'POST' : 'GET');
    lines.push(`${method} ${url}${p.httpURLQuery || p.queryString ? '?' + (p.httpURLQuery || p.queryString) : ''}`);
    if (p.httpRequestHeaders) lines.push(`# Cabeceras reenviadas: ${p.httpRequestHeaders}`);
    lines.push(`Authorization: <${p.authenticationType || p.authenticationMethod || 'autenticación'}${cred ? ' - ' + cred : ''}>`);
  } else if (adapter === 'jms') {
    language = 'text';
    lines.push(`Cola JMS (${mf.direction === 'Sender' ? 'consumo' : 'publicación'}): ${p.QueueName_outbound || p.QueueName_inbound || p.QueueName || '{{Cola}}'}`);
    if (p.ExpirationPeriod) lines.push(`Caducidad del mensaje: ${p.ExpirationPeriod} días`);
    if (p.AccessType) lines.push(`Acceso: ${p.AccessType}`);
    if (p.UseMessageCompression === '1') lines.push('Compresión de mensaje: activada');
    if (p.EncryptMessage === '1') lines.push('Cifrado de mensaje: activado');
  } else if (adapter === 'processdirect') {
    language = 'text';
    lines.push(`ProcessDirect -> ${p.address || '(dirección)'}`);
  } else if (adapter === 'sftp') {
    language = 'text';
    lines.push(`SFTP ${p.address || '{{Host}}'} - directorio ${p.path || p.directory || '-'} - fichero ${p.fileName || '-'}`);
  } else if (adapter === 'mail') {
    language = 'text';
    lines.push(`Mail ${p.address || '{{ServidorSMTP}}'} - de ${p.from || '-'} - a ${p.to || '-'}`);
  } else if (adapter === 'soap') {
    lines.push(`POST ${p.address || '{{URL}}'}`);
    lines.push('Content-Type: text/xml; charset=UTF-8');
    if (p.soapAction) lines.push(`SOAPAction: ${p.soapAction}`);
  } else if (adapter === 'odata') {
    lines.push(`${p.operation || 'GET'} ${p.address || '{{URL}}'}/${p.resourcePath || ''}${p.customQueryOptions ? '?' + p.customQueryOptions : ''}`);
  } else {
    language = 'text';
    for (const [k, v] of adapterProps(mf).slice(0, 12)) lines.push(`${k}: ${v}`);
  }
  return { language, text: lines.join('\n'), notes };
}
