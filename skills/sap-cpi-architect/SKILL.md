---
name: sap-cpi-architect
description: >-
  Use this skill when the user wants to: (Mode 1) Design and package a complete SAP Cloud
  Integration (CPI / Integration Suite) iFlow + Script Collection OSGi .zip bundle from a
  natural-language functional specification using the 3-stage pipeline (Plan -> BPMN2 .iflw
  XML -> Groovy Scripts), (Mode 2) Reverse-engineer and generate comprehensive 8-section
  technical documentation from an existing iFlow .zip bundle, OR (Mode 3) Clone and adapt
  an existing reference iFlow and Script Collection .zip bundle to a new API specification.
---

# SAP CPI Architect: iFlow Generator, Cloner & Reverse-Engineering Documentor

Operates in three specialized modes:
- **Modo 1 · Generar iFlow + Script Collection (`.zip`)**: Designs an enterprise-grade iFlow in 3 stages (Plan -> BPMN2 `.iflw` XML -> Groovy Scripts), validates all artifacts, and builds real OSGi `.zip` bundles importable into SAP Integration Suite.
- **Modo 2 · Documentar iFlow Existente**: Extracts an existing `.zip` bundle, runs static heuristics, and generates the 8-section technical & architectural documentation.
- **Modo 3 · Clonar y Adaptar Bundles de Referencia (`.zip`) según Nueva Especificación**: Clones an existing working iFlow + Script Collection `.zip` template, adapts scripts, XPath splitters, and OSGi descriptors to a new functional/API specification, and preserves private `.prop` files untouched.

---

## Modo 1: Generar iFlow + Script Collection (Pipeline en 3 Etapas)

### Etapa 0: Protocolo de Clarificación Interactiva (Preguntar antes de Asumir)
Antes de generar el plan arquitectónico o el paquete `.zip`, analiza si el prompt del usuario define todos los parámetros críticos del flujo de integración. **Si falta información clave, realiza preguntas breves y estructuradas (proponiendo valores recomendados) para obtener el contexto necesario**:
1. **Sistemas Origen y Destino (Sender / Receiver)**: ¿Qué adaptadores utilizan (HTTPS, OData v2/v4, SFTP, SOAP, IDoc, JMS, ProcessDirect) y si la comunicación es síncrona (`Request-Reply`) o asíncrona?
2. **Contratos de Datos y Transformaciones**: ¿Qué formato entra y sale (JSON, XML, IDoc, CSV) y qué reglas de negocio o enriquecimientos (`Content Modifier`, `Router`, `Groovy Script`) deben aplicarse?
3. **Seguridad y Parámetros Externalizados**: ¿Qué método de autenticación requiere cada endpoint (OAuth2 Client Credentials, Basic Auth / User Credential alias, Client Certificate) y qué timeouts se esperan?
4. **Gestión de Errores y Alertas**: ¿Qué debe hacer el `Exception Subprocess` cuando ocurre un fallo (enviar alerta por correo, guardar en cola JMS, retornar estructura de error HTTP personalizada)?

> **Regla de Vía Rápida**: Si el usuario ya proporcionó una especificación completa o pide explícitamente que asumas valores por defecto de mejores prácticas SAP, procede directamente a la Etapa 1 documentando los supuestos tomados.

### Etapa 1: Plan Arquitectónico (`plan.json`)
Design the JSON plan containing:
- `iflowName` (PascalCase with underscores, e.g., `Order_Sync_S4HANA`)
- `scriptCollectionName` (`SC_<iflowName>`)
- `businessDescription` & `technicalSummary`
- `parameters` (every external URL, credential alias, or timeout externalized as `KEY: defaultValue`)
- `components[]` (ordered steps: `StartEvent`, `ContentModifier`, `RequestReply`, `Router`, `ScriptTask`, `ExceptionSubprocess`, `EndEvent`)
- `groovyScriptsPlan[]` (`{ fileName, purpose }`)

### Etapa 2: BPMN 2.0 XML (`<iflowName>.iflw`)
Generate the complete BPMN 2.0 XML implementing every step of the plan following SAP's official *Integration Flow Design Guidelines*:
- Must include `<bpmn2:definitions>` with namespaces `bpmn2`, `bpmndi`, `ifl`, `dc`, `di`.
- Must include `<bpmn2:collaboration>` (Sender, Receiver, Integration Process) and `<bpmn2:process>`.
- Must include `<bpmn2:subProcess triggeredByEvent="true" ifl:type="ExceptionSubProcess">` (or `ErrorEventSubProcessTemplate`):
  - **Resilient Error & Transaction Architecture**: Differentiate between **transient errors** (use JMS Queues with automatic retry/backoff) and **persistent/poison errors** (route to a Data Store or Dead-Letter Queue in the Exception Subprocess, and optionally forward alerts via `ProcessDirect` to a central Error Logging iFlow). Keep transaction boundaries short by isolating transactional steps inside Local Integration Processes.
- **Splitter & Message Mapping Streaming ("Split-First" Rule)**:
  - All `Splitter` steps (`General Splitter` / `Iterating Splitter`) must enable streaming (`<ifl:property key="streaming" value="true"/>`) and use direct XPath expressions without heavy predicates.
  - Never pass mega-payloads (> 50 MB) directly into a graphical Message Mapping (DOM trap); always place a streaming `Splitter` before the Message Mapping.
- **Router Optimization**:
  - Extract XML values into typed Exchange Properties (`java.lang.String`, `java.lang.Long`) in a `Content Modifier` *before* the `Router`, and evaluate `${exchangeProperty.Field}` (Camel Simple) instead of evaluating repeated XPath across multiple Router branches.
  - Order Router branches from most frequent to least frequent, and always define a `default` route on `<bpmn2:exclusiveGateway>`.
- All external endpoints must use `https://` and externalized parameters `{{PARAM_NAME}}`.
- All synchronous `ExternalCall` tasks must declare an explicit `timeout` property (e.g., `60000`).
- Every Script Task must reference `<ifl:property key="scriptFunction" value="processData"/>` and `<ifl:property key="script" value="<fileName>"/>`.
- Must include `<bpmndi:BPMNDiagram>` coordinates so the SAP CPI Web UI editor renders the diagram cleanly.
- **Patrones Opcionales para *Handlers* Transversales Reutilizables**:
  - **Handler Centralizado de Errores y Observabilidad (`ProcessDirect` -> `Parallel Multicast`)**:
    - Recibe un sobre XML de error vía `ProcessDirect` (`{{PD_address}}`) desde los `Exception Subprocess` de otros iFlows, respaldado por un XSD tolerante donde todos los campos son `minOccurs="0" nillable="true"` (incluyendo `Environment`, `InterfaceName`, `InterfaceDescription`, `ObjectID`, `ExceptionMessage`, `OriginalMessageProcessingLogID`, `SAP_MessageProcessingLogID`, `SAP_MplCorrelationId` y banderas como `SendBody`).
    - Usa un `Parallel Multicast` para dividir el flujo en dos ramas: (1) una rama de alerta por correo (`Mail` SMTP con `starttls_mandatory`) que formatea una tabla HTML en un `Content Modifier`, y (2) una rama de observabilidad hacia **SAP Cloud Logging / OpenSearch** que evalúa `${exchangeProperty.SendBody.toLowerCase()} = 'yes'` en un `Router` para elegir entre dos `Message Mapping` (`WithBody.mmap` vs `NoBody.mmap`), convierte la salida con `XML to JSON Converter` (`xmlJsonSuppressRootElement=true`) y la envía por `HTTP` POST con certificado de cliente (`{{CloudLoggingCertificate}}`).
    - Incluye su propio `Exception Subprocess` local que inspecciona `CamelExceptionCaught` y guarda el detalle como adjunto MPL (`addAttachmentAsString`) para evitar bucles infinitos si falla el servidor de correo o de logs.
  - **Handler Centralizado de Refresco de Tokens (`StartTimerEvent` -> `LocalIntegrationProcess` -> Global `Data Store`)**:
    - Inicia con un `StartTimerEvent` parametrizado (`{{TokenTimer}}` de tipo `custom:schedule` en `parameters.propdef`), delega la llamada `ExternalCall` y extracción del token a un `LocalIntegrationProcess` (`processType="directCall"`), limpia cabeceras y propiedades internas en un `Content Modifier` mediante acciones `Delete` (`$name=Authorization`, `$name=SAP_MonitoringStateProperties`, `$name=Content-Length`, etc.) y persiste la cabecera/token en un **Data Store Global Cifrado** (`activityType="DBstorage"`, `operation="put"`, `visibility="global"`, `encrypt="true"`, `override="true"`, `includeMessageHeaders="true"`).

### Etapa 3: Scripts Groovy (`src/main/resources/script/*.groovy`)
Author each Groovy script planned in `groovyScriptsPlan[]` following all SAP CPI Scripting Guidelines (`def Message processData(Message message)`, `Reader` streaming, `JsonSlurperClassic`, `XmlSlurper` with `disallow-doctype-decl`, `ZoneId.of("UTC")`, conditional MPL attachments, `CPI-ERR:` exception rethrow).

### Etapa 4: Validación y Construcción de los Bundles OSGi (`.zip`)
Save your specification JSON (containing `iflowName`, `scriptCollectionName`, `businessDescription`, `parameters`, `iflwXml`, and `groovyScripts`) and execute `build-cpi-package.mjs`:

```bash
node ./scripts/build-cpi-package.mjs <spec.json | --demo> --out-dir ./dist-packages
```

* OSGi Packager & Validator script: [build-cpi-package.mjs](./scripts/build-cpi-package.mjs)
* OSGi Bundle Specification: [osgi-bundle-spec.md](./references/osgi-bundle-spec.md)
* SAP S/4HANA API documentation (how to read the official pages and what to check before calling an API): [s4hana-api-docs.md](./references/s4hana-api-docs.md)
* **Verification Gate & OSGi Manifest Compliance**:
  - `build-cpi-package.mjs` validates both the `.iflw` BPMN2 XML and every Groovy script before producing `<iflowName>.zip`, `<scriptCollectionName>.zip`, and `Paquete_<iflowName>.zip`.
  - Places `.project` and `META-INF/MANIFEST.MF` **directly at the root of the `.zip`** (never nested inside a top-level wrapper folder) and wraps all `MANIFEST.MF` lines at **72 bytes UTF-8** with `\r\n ` continuations so SAP CPI never fails with `The project must contain a valid manifest file`.
  - Always remind the user to upload `<scriptCollectionName>.zip` (in *Add -> Script Collection*) and `<iflowName>.zip` (in *Add -> Integration Flow*) individually, rather than uploading the outer `Paquete_<iflowName>.zip` wrapper.

---

> **Formatos OSGi reales (verificados con exportaciones de SAP)**: `.project` con buildCommand `org.eclipse.jdt.core.javabuilder` y naturalezas `org.eclipse.jdt.core.javanature` + `com.sap.ide.ifl.project.support.project.nature` + `com.sap.ide.ifl.bsn` (iFlow / Script Collection) o `com.sap.ide.ifl.valmap` (Value Mapping). Los Value Mapping (`build-value-mapping.mjs`) usan `<vm version="2.0"><group id="<hex32>"><entry><agency/><schema/><value/></entry>…</group></vm>` y un MANIFEST con `Import-Package: com.sap.xi.mapping.camel.valmap` y `Bundle-Activator: com.sap.xi.mapping.camel.valmap.ValueMappingActivator`. `value_mapping.xml` va en la **raíz** del bundle (como en el ejemplo oficial `TestValueMap.zip` de SAP) y `Bundle-SymbolicName` lleva `; singleton:=true`. Por convención, el Value Mapping se crea en el **mismo paquete de integración** que el iFlow que lo consume, pero los pares agencia/identificador son globales al tenant y no pueden repetirse entre Value Mappings desplegados.

## Modo 2: Documentar iFlow Existente (Ingeniería Inversa en 8 Secciones)

### Paso 0: Clarificación de Alcance Documental
Antes de redactar la documentación técnica, verifica:
1. Si el usuario ha proporcionado la ruta al archivo `.zip` o `.iflw`. Si no lo ha indicado, pídele la ruta del paquete.
2. Si necesita enfatizar algún aspecto específico para la audiencia del documento (ej. equipo de Operaciones/Soporte, auditoría de Seguridad BTP, o traspaso a Producción) o añadir contexto de negocio que no figure dentro del `.iflw`.

### Paso 1: Extraer Contexto y Heurísticas del `.zip`
Run `extract-for-docs.mjs` on the existing `.zip` bundle:

```bash
node ./scripts/extract-for-docs.mjs <existing-iflow.zip | --demo>
```

* Extractor & Doc Validator script: [extract-for-docs.mjs](./scripts/extract-for-docs.mjs)
* 8-Section Template: [doc-template-8-sections.md](./references/doc-template-8-sections.md)

### Paso 2: Redactar y Validar las 8 Secciones Obligatorias
Write the Markdown documentation following the exact 8 headings in [doc-template-8-sections.md](./references/doc-template-8-sections.md) and validate the generated `.md` file with:

```bash
node ./scripts/extract-for-docs.mjs --validate-doc <generated-doc.md>
```

---

## Modo 3: Clonar y Adaptar Bundles de Referencia (`.zip`) según Nueva Especificación

Use this mode when the user provides an existing SAP CPI package (`.zip` containing one or more iFlows and/or a `ScriptCollection`) and asks to create new integrations or update existing ones based on an API specification document (PDF, Markdown, OpenAPI).

### Paso 0: Análisis de Brechas (Gap Analysis) y Regla de Privacidad
1. **Inspección sin Exposición de Datos Privados (Privacy-First)**:
   - Inspecciona la estructura de los `.zip` con `inspect-iflow-zip.mjs` (que redacta automáticamente los valores de `.prop` como `[REDACTED]`).
   - **NUNCA** leas ni imprimas valores sensibles de `parameters.prop` (credenciales, endpoints privados, colas internas) ni subas paquetes de cliente al repositorio Git salvo instrucción explícita.
2. **Contraste Especificación vs. Implementación y Preguntas de Clarificación**:
   - Compara los filtros de consulta, campos solicitados, tablas de resolución de referencias y esquemas JSON/XML entre el bundle de referencia y el documento de especificación.
   - Si el documento presenta puntos abiertos, campos heredados de entidades padre (dot-walking vs `null`), o discrepancias de nombres de campo (ej. campo canónico vs campo alternativo), **pregunta al usuario antes de escribir código** proponiendo la opción recomendada primero.

### Paso 1: Adaptar o Crear los Scripts en la Script Collection
1. Crea los nuevos scripts `.groovy` (y actualiza los existentes si el usuario lo solicitó) manteniendo el patrón arquitectónico de la Script Collection original.
2. Asegúrate de que:
   - El paquete de `XmlSlurper` coincida con la versión de Groovy del paso Script (que no se deduce de la API `Message`): **Groovy 2.4** → `groovy.util.XmlSlurper` (`groovy.xml.XmlSlurper` falla con `unable to resolve class`); **Groovy 4** → `groovy.xml.XmlSlurper` (`groovy.util.XmlSlurper` fue eliminado). Valida con `validate-groovy.mjs --groovy 2.4|4`.
   - Al leer desde un `Reader` (`BufferedReader` / `StringReader`), **nunca** se invoque `bodyReader.getText('UTF-8')` con parámetro de charset (lanza `MissingMethodException`); usa `bodyReader.getText()` **sin argumentos** o pasa `bodyReader` directamente a `.parse(bodyReader)`.
   - Toda constante a nivel de script con `@Field` incluya `final` (`@Field final`), el parseo XML deshabilite `disallow-doctype-decl`, y el parseo JSON use `JsonSlurperClassic`.
3. Valida todos los scripts en lote con `validate-groovy.mjs`:

```bash
node ../sap-cpi-groovy-generator/scripts/validate-groovy.mjs <carpeta-scripts> --strict
```

### Paso 2: Clonar los iFlows y Empaquetar la Script Collection
Ejecuta `clone-iflow-bundle.mjs` para clonar cada iFlow de referencia (actualizando `.project`, `META-INF/MANIFEST.MF`, `metainfo.prop`, `<NuevoNombre>.iflw`, referencias a scripts `.groovy` y expresiones XPath del Splitter) y para inyectar los nuevos scripts en la Script Collection `.zip`:

```bash
# 1. Clonar y adaptar un iFlow .zip manteniendo intactos sus diagramas BPMN2 y .prop
node ./scripts/clone-iflow-bundle.mjs --source <Referencia_iFlow.zip> --target-name <Nuevo_iFlow> --out <Nuevo_iFlow.zip> --replace <ScriptViejo.groovy=ScriptNuevo.groovy> --xpath <//nodoViejo=//nodoNuevo> [--add-resource <Esquema.xsd>] [--add-resource <Mapeo.mmap>]

# 2. Inyectar o actualizar archivos sueltos (.xsd, .mmap, .xsl, .wsdl, .groovy) en un iFlow .zip existente (sin renombrarlo)
node ./scripts/clone-iflow-bundle.mjs --source <iFlow_Existente.zip> --add-resource <NuevoEsquema.xsd> --add-resource <NuevoMapeo.mmap> --out <iFlow_Actualizado.zip>

# 3. Actualizar la Script Collection .zip con los nuevos scripts validados
node ./scripts/clone-iflow-bundle.mjs --update-sc <SC_Origen.zip> --scripts-dir <carpeta-scripts> --out <SC_Actualizada.zip> --strict
```

* Cloner & SC Updater script: [clone-iflow-bundle.mjs](./scripts/clone-iflow-bundle.mjs)
* **Normalización Automática de Estructura OSGi ZIP**: `clone-iflow-bundle.mjs` detecta y elimina automáticamente cualquier carpeta raíz intermedia heredada del `.zip` de origen (`stripRootFolderPrefix`), garantizando que `.project` y `META-INF/MANIFEST.MF` queden siempre en la raíz del `.zip` y con plegado de 72 bytes UTF-8 (`wrapManifestLine72`).
* Verifica finalmente todos los `.zip` generados ejecutando `inspect-iflow-zip.mjs` sobre cada paquete resultante (comprobando `manifestIssues: []`) e indica al usuario qué archivos `.zip` individuales debe subir en SAP CPI (*Script Collection* vs *Integration Flow*).

---

## Modo 4: Exportar Clientes de Prueba API (Postman v2.1 & OpenAPI 3.0)

Genera colecciones Postman v2.1 y especificaciones OpenAPI 3.0.3 listas para pruebas E2E a partir de los canales remitentes de un iFlow `.zip`:

```bash
node ./scripts/export-api-client.mjs <iflow.zip | --demo> [--out-dir <carpeta>] [--base-url <url-tenant>] [--format postman|openapi|both] [--json]
node ./scripts/export-api-client.mjs <iflow.zip | --demo> --endpoints [--json]
```

* Script CLI: [export-api-client.mjs](./scripts/export-api-client.mjs)
* **Extracción de Matriz de Endpoints (`--endpoints` o MCP `cpi_get_iflow_endpoints`)**: Extrae en milisegundos los canales inbound y outbound, detecta protección CSRF (`isCsrfProtected`) y timeouts, conserva las direcciones externalizadas como `{{param}}` (los valores de `parameters.prop` solo se resuelven con `--resolve-params`) y rechaza con gracia paquetes sin `.iflw` como Script Collections.
* **Handshake CSRF Automático**: Genera una petición GET independiente y programa un script `prerequest` en el POST (`pm.sendRequest` con `X-CSRF-Token: Fetch` y `Basic {{CPI_BASIC_AUTH}}`) para autorizar llamadas de forma autónoma tanto en Postman UI como en Newman / CI/CD.
* **Parámetros Externalizados (privacidad por defecto)**: Si la URL del adaptador remitente usa `{{param}}` (ej. `{{StorefrontEndpoint}}`), se conserva como variable `{{param}}` de Postman/OpenAPI. Solo con `--resolve-params` (opt-in explícito; `resolveParams: true` en MCP) se leen los valores de `parameters.prop`.
* **Esquemas y Payloads Duales**: Sintetiza ejemplos tanto en `application/xml` como en `application/json` a partir de los esquemas XSD del paquete.



## Qué garantiza el script (LL-021, LL-022)

- `build-cpi-package.mjs` no escribe ningún zip si hay errores, escapa `parameters.prop`/`.propdef` como `java.util.Properties` (`\\`, `=`, `:` y saltos de línea) y escapa el texto XML. El DEMO lleva el timeout en el canal (`messageFlow`), no en la tarea.
- `build-value-mapping.mjs` lee CSV RFC 4180 (comillas, `,` o `;` detectado automáticamente) y avisa de pares agencia/valor duplicados en lugar de fallar con stack trace.
- `export-api-client.mjs` toma la ruta del sender HTTPS de `urlPath` (SOAP/IDoc/ProcessDirect usan `address`) y rechaza bundles que no son un iFlow (p. ej. una Script Collection).
- `clone-iflow-bundle.mjs` actualiza las referencias del `.iflw` cuando renombra scripts de una Script Collection.
- `build-cpi-package.mjs` se niega a empaquetar (`SANITIZED-001`) si el `.iflw` o los scripts contienen alias de `sanitize-iflow-zip.mjs` (`*.sanitized.invalid`, `SANITIZED_*`, `urn:sanitized:`). Restaura primero con `--restore` (LL-027).

## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un **error de subida o ejecución en SAP CPI**, corrija un artefacto generado o comparta un paquete `.zip` de referencia, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente el patrón técnico genérico de SAP CPI, sin guardar jamás nombres de proyectos privados, clientes, endpoints ni valores de `.prop`.
2. **Codificar en el Script CLI**: Actualizar el script validador/generador correspondiente en `./scripts/` para detectar o prevenir determinísticamente ese caso en el futuro.
3. **Actualizar Documentación y Lecciones**: Documentar la mejora en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
