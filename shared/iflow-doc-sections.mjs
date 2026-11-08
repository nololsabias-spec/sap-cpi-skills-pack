/**
 * Compone el documento técnico completo (secciones 1-10) a partir del modelo del .iflw.
 * No incluye auditoría ni menciona ficheros de configuración: solo diseño, interfaces y operación.
 */
import { stepTypeLabel, orderNodes, adapterProps } from './iflow-model.mjs';
import { functionalStep } from './iflow-functional.mjs';
import { buildMappingBlocks } from './iflow-mappings.mjs';

const para = (text) => ({ type: 'paragraph', text });
const sec = (text) => ({ type: 'section', text });
const sub = (text, keep) => ({ type: 'subsection', text, ...(keep ? { keep } : {}) });
const listAnd = (arr) => (arr.length > 1 ? `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}` : arr[0] || 'ningún sistema');
const propOf = (mf, re) => (adapterProps(mf).find(([k]) => re.test(k)) || [])[1];

export function buildDocument(report, model, c) {
  const { comps, systems, mfs, names, privacy, mv, out } = c;
  const m = report.manifestData || {};
  const h = report.heuristics || {};
  const doc = [];
  const main = comps.find((x) => x.isMain) || comps[0];
  const steps = model.nodes.filter((n) => n.tag !== 'subProcess');
  const startNode = main?.nodes.find((n) => /^Start/.test(n.activityType || ''));
  const trigger = startNode ? stepTypeLabel(startNode) : 'No identificado';
  const sources = [...systems.values()].filter((x) => x.directions.has('Sender')).map((x) => x.label);
  const targets = [...systems.values()].filter((x) => x.directions.has('Receiver')).map((x) => x.label);
  const adapters = [...new Set(mfs.map((x) => x.adapter).filter(Boolean))];
  const scripts = model.nodes.filter((n) => n.activityType === 'Script');
  const collections = [...new Set([...(h.referencedScriptCollections || []), ...scripts.map((n) => n.props?.scriptBundleId).filter(Boolean)])];
  const hasMail = mfs.some((x) => /mail/i.test(x.adapter || ''));
  const errComps = comps.filter((x) => x.isSubProcess || /exception|error/i.test(x.title));

  doc.push({ type: 'pagebreak' });
  doc.push(sec('Contenido'));
  doc.push({ type: 'toc' });

  // 1
  doc.push({ type: 'pagebreak' });
  doc.push(sec('1. Objetivo y alcance'));
  doc.push(para(`Este documento describe el diseño técnico del iFlow «${m.name || report.fileName}» de SAP Cloud Integration: qué hace, cómo está construido, con qué sistemas se comunica y cómo se configura y opera. Está dirigido a desarrolladores, equipos de soporte y arquitectos que deban mantener o evolucionar la integración. La evaluación de calidad o cumplimiento (auditoría) se entrega en un documento independiente.`));
  doc.push(para(`El flujo se inicia mediante ${trigger.toLowerCase()}${sources.length ? `, recibe información de ${listAnd(sources)}` : ''} y entrega el resultado a ${listAnd(targets)}. En total orquesta ${steps.length} pasos repartidos en ${comps.length} proceso(s) y utiliza ${mfs.length} canal(es) de comunicación (${adapters.join(', ') || 'sin adaptadores'}).`));
  doc.push(sub('1.1 Ficha técnica'));
  doc.push({
    type: 'table', fontSize: 7.8,
    columns: [{ title: 'Característica', weight: 3, bold: true }, { title: 'Valor', weight: 7 }],
    rows: [
      ['Nombre del iFlow', m.name || report.fileName],
      ['Identificador (Bundle-SymbolicName)', m.symbolicName || 'N/D'],
      ['Versión', m.version || '1.0.0'],
      ['Tipo de artefacto', m.bundleType || 'IntegrationFlow'],
      ['Perfil de ejecución', 'IFLMAP (Cloud Integration, nodo de ejecución)'],
      ['Disparador', trigger],
      ['Procesos', comps.map((x) => `${x.kindLabel}: ${x.title}`).join('\n')],
      ['Pasos / canales', `${steps.length} pasos / ${mfs.length} canales`],
      ['Sistemas externos', [...systems.values()].map((x) => `${x.label} (${[...x.adapters].join('/')})`).join('\n') || 'Ninguno'],
      ['Scripts Groovy', scripts.length ? `${scripts.length} (${collections.length ? 'Script Collection: ' + collections.join(', ') : 'locales'})` : 'Ninguno'],
      ['Parámetros externalizados', String(names.length)],
      ['Manejo de excepciones', h.hasExceptionSubprocess || errComps.length ? 'Subproceso de excepción configurado' : 'No detectado']
    ]
  });
  doc.push(sub('1.2 Convenciones del documento'));
  doc.push({ type: 'bullet', text: '{{Parametro}}: parámetro externalizado cuyo valor se define en el tenant en cada entorno.' });
  doc.push({ type: 'bullet', text: '${...}: expresión Camel Simple evaluada en tiempo de ejecución (cabeceras, propiedades, body).' });
  doc.push({ type: 'bullet', text: 'Los ejemplos de llamada y respuesta emplean datos sintéticos; no reflejan datos reales.' });
  if (privacy) doc.push(...out.overview.filter((b) => b.type === 'callout'));

  // 2
  doc.push(sec('2. Arquitectura de la solución'));
  doc.push(para('El esquema muestra cada proceso de izquierda a derecha. Los sistemas externos aparecen sobre o bajo el paso que los usa, con el adaptador indicado en el conector. Si el proceso es largo se divide en tramos enlazados por conectores A, B, C.'));
  const stop = out.architecture.findIndex((x) => x.type === 'subsection' && /^2\.2/.test(x.text || ''));
  doc.push(...out.architecture.slice(0, stop < 0 ? out.architecture.length : stop));
  doc.push(sub('2.2 Sistemas y participantes'));
  doc.push({
    type: 'table',
    columns: [{ title: 'Sistema', weight: 3, bold: true }, { title: 'Adaptador', weight: 2 }, { title: 'Rol', weight: 2 }],
    rows: [...systems.values()].map((x) => [x.label, [...x.adapters].join(', '), [...x.directions].map((d) => (d === 'Sender' ? 'Origen (entrada)' : 'Destino (salida)')).join(', ')])
  });

  // 3
  doc.push(sec('3. Flujo funcional'));
  doc.push(para('Para cada proceso se explica qué aporta cada paso al ciclo de negocio, qué datos consume y qué produce (propiedades, cabeceras o cuerpo), La configuración técnica detallada puede consultarse directamente en el iFlow.'));
  comps.forEach((comp, idx) => {
    const ordered = orderNodes(comp.nodes, model.flows);
    doc.push(sub(`3.${idx + 1} ${comp.kindLabel}: ${comp.title}`, 120));
    doc.push({
      type: 'table', fontSize: 7.2,
      columns: [{ title: '#', weight: 0.45 }, { title: 'Paso', weight: 2.3, bold: true }, { title: 'Qué aporta al ciclo', weight: 5 }, { title: 'Consume', weight: 2.4 }, { title: 'Produce', weight: 2.4 }],
      rows: ordered.map((n, i) => {
        const f = functionalStep(n, model, report);
        return [String(i + 1), `${n.name || n.id}\n(${stepTypeLabel(n)})`, mv(f.purpose), mv(f.inputs), mv(f.outputs)];
      })
    });
    const gw = new Map(ordered.filter((n) => /Gateway/.test(n.tag)).map((n) => [n.id, n]));
    const routes = model.flows.filter((f) => gw.has(f.from) && (f.condition || f.name));
    if (routes.length) {
      doc.push(para('Rutas de decisión:'));
      doc.push({
        type: 'table', fontSize: 7.4,
        columns: [{ title: 'Decisión', weight: 2.5, bold: true }, { title: 'Ruta', weight: 2.5 }, { title: 'Condición', weight: 5, mono: true }],
        rows: routes.map((f) => [gw.get(f.from).name || f.from, f.name || '-', mv(f.condition || '(por defecto)')])
      });
    }
  });

  // 4
  doc.push(sec('4. Interfaces y endpoints'));
  if (mfs.length) {
    doc.push(para('Canales de comunicación del flujo. Las direcciones se expresan con parámetros externalizados; el valor concreto depende del entorno.'));
    doc.push(...out.annexes.filter((b) => b.type !== 'section'));
  } else doc.push(para('El flujo no define canales de entrada ni de salida.'));

  // 5
  doc.push(sec('5. Configuración externalizada'));
  if (names.length) {
    doc.push(para(`El iFlow expone ${names.length} parámetro(s) configurables en el tenant (Configure) sin modificar el diseño. Se documentan nombre, tipo, obligatoriedad y uso; los valores no se reproducen aquí.`));
    doc.push(...out.parameters.filter((b) => b.type === 'table'));
  } else doc.push(para('El iFlow no utiliza parámetros externalizados; toda la configuración está embebida en el diseño.'));

  // 6
  doc.push(sec('6. Scripts y transformaciones'));
  if (scripts.length) {
    doc.push(sub('6.1 Scripts Groovy'));
    doc.push(para(`El flujo ejecuta ${scripts.length} script(s) Groovy${collections.length ? ' alojados en la Script Collection ' + collections.join(', ') : ''}. Cada script opera sobre el objeto Message (cuerpo, cabeceras y propiedades).`));
    doc.push(...out.scripts);
  } else doc.push(para('No hay scripts Groovy en el flujo.'));
  doc.push(...buildMappingBlocks(report, model, { mv, hasScripts: scripts.length > 0, privacy }));

  // 7
  doc.push(sec('7. Gestión de errores'));
  if (errComps.length) {
    doc.push(para('Los fallos no controlados se derivan al subproceso de excepción, que ' + (hasMail ? 'notifica por correo' : 'ejecuta las acciones indicadas') + ' y finaliza el procesamiento.'));
    doc.push({
      type: 'table', fontSize: 7.4,
      columns: [{ title: 'Proceso', weight: 2.6, bold: true }, { title: 'Tipo', weight: 2.4 }, { title: 'Secuencia de pasos', weight: 5 }],
      rows: errComps.map((comp) => [
        comp.title.replace(/ \(dentro de .*\)$/, ''),
        comp.title.match(/\(dentro de (.*)\)$/) ? `Subproceso de ${comp.title.match(/\(dentro de (.*)\)$/)[1]}` : comp.kindLabel,
        orderNodes(comp.nodes, model.flows).map((x, i) => `${i + 1}. ${x.name || stepTypeLabel(x)}`).join('\n')
      ])
    });
  } else doc.push({ type: 'callout', tone: 'warn', text: 'No se detectó subproceso de excepción: los errores solo quedarían registrados en el monitor de mensajes.' });
  if (mfs.length) {
    doc.push(sub('7.1 Comportamiento por canal'));
    doc.push({
      type: 'table', fontSize: 7.4,
      columns: [{ title: 'Sistema', weight: 3, bold: true }, { title: 'Adaptador', weight: 2 }, { title: 'Timeout', weight: 2 }, { title: 'Reintentos', weight: 2 }],
      rows: mfs.map((mf) => [mf.systemName || mf.participantId || '-', mf.adapter || '-', mv(propOf(mf, /timeout/i) || 'por defecto'), mv(propOf(mf, /retry|retention/i) || 'por defecto')])
    });
  }

  // 8
  doc.push(sec('8. Seguridad'));
  doc.push({ type: 'bullet', text: 'Las credenciales no se almacenan en el iFlow: se referencian por alias de Security Material (User Credentials / OAuth2) definidos en el tenant.' });
  doc.push({ type: 'bullet', text: 'Los endpoints se externalizan mediante parámetros; se recomienda HTTPS/TLS en todos los canales HTTP.' });
  doc.push({ type: 'bullet', text: 'Los datos de negocio no deben registrarse en trazas de producción; usar niveles de traza controlados.' });
  if (mfs.length) {
    doc.push({
      type: 'table', fontSize: 7.4,
      columns: [{ title: 'Sistema', weight: 3, bold: true }, { title: 'Adaptador', weight: 2 }, { title: 'Método', weight: 2.5 }, { title: 'Alias de credencial', weight: 3, mono: true }],
      rows: mfs.map((mf) => [mf.systemName || mf.participantId || '-', mf.adapter || '-', mv(propOf(mf, /authentication/i) || 'No definida'), mv(propOf(mf, /credential/i) || '-')])
    });
  }

  // 9
  doc.push(sec('9. Operación y mantenimiento'));
  doc.push(sub('9.1 Despliegue'));
  ['Importar el paquete en Design y configurar los parámetros del entorno (Configure).',
    'Crear en Security Material los alias de credenciales referenciados.',
    collections.length ? `Verificar que la Script Collection ${collections.join(', ')} está disponible.` : 'Verificar que no existen dependencias externas pendientes.',
    'Desplegar y comprobar el estado Started en Monitor > Integration Content.'].forEach((x, i) => doc.push({ type: 'bullet', text: `${i + 1}. ${x}` }));
  doc.push(sub('9.2 Monitorización'));
  doc.push(para('Monitor > Message Processing: filtrar por el nombre del iFlow y por estado (Failed, Retry). Usar el Message ID para localizar el paso fallido y su traza.'));
  doc.push(sub('9.3 Resolución de incidencias frecuentes'));
  const issues = [['HTTP 401/403 en una llamada', 'Alias de credencial incorrecto o sin permisos', 'Revisar el alias en Security Material y los permisos en el sistema destino']];
  if (adapters.some((a) => /jms/i.test(a))) issues.push(['Error al enviar a la cola JMS', 'Cola inexistente o cuota de mensajería agotada', 'Verificar la cola y su consumo en Monitor > Message Queues']);
  if (adapters.some((a) => /servicenow|http|odata|soap|rest/i.test(a))) issues.push(['Timeout en la llamada externa', 'Sistema lento o consulta demasiado amplia', 'Reducir el tamaño de página o el rango de consulta, o ampliar el timeout']);
  if (scripts.length) issues.push(['Error de compilación o MissingMethodException en Groovy', 'API de script no compatible con el runtime', 'Revisar el script con el validador Groovy']);
  issues.push(['Mensaje en estado Retry', 'Fallo transitorio en el destino', 'Revisar el error asociado; el reintento es automático según el canal']);
  doc.push({ type: 'table', fontSize: 7.4, columns: [{ title: 'Síntoma', weight: 3, bold: true }, { title: 'Causa probable', weight: 3 }, { title: 'Acción', weight: 4 }], rows: issues });

  // 10
  doc.push(sec('10. Supuestos, limitaciones y glosario'));
  doc.push({ type: 'bullet', text: 'Este documento se genera a partir del diseño del iFlow; no refleja datos ni volúmenes en ejecución.' });
  doc.push({ type: 'bullet', text: 'Los valores de configuración del tenant se mantienen fuera del documento por seguridad.' });
  doc.push(sub('10.1 Glosario'));
  const gl = [['iFlow', 'Flujo de integración desplegable en SAP Cloud Integration.'], ['Script Collection', 'Paquete reutilizable de scripts Groovy compartido entre iFlows.'], ['Camel Simple', 'Lenguaje de expresiones de Apache Camel: ${header.X}, ${property.X}.']];
  if (adapters.some((a) => /jms/i.test(a))) gl.push(['JMS', 'Mensajería asíncrona basada en colas del Integration Suite.']);
  if (model.nodes.some((n) => /Multicast|Join/.test(n.activityType || ''))) gl.push(['Parallel Multicast / Join', 'Divide el mensaje en ramas paralelas y las reúne después.']);
  if (errComps.length) gl.push(['Exception Subprocess', 'Subproceso que captura los errores no controlados del proceso principal.']);
  doc.push({ type: 'table', fontSize: 7.6, columns: [{ title: 'Término', weight: 3, bold: true }, { title: 'Definición', weight: 8 }], rows: gl });
  return doc;
}
