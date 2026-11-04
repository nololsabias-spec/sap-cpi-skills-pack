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
  - Extract XML values into typed Exchange Properties (`java.lang.String`, `java.lang.Long`) in a `Content Modifier` *before* the `Router`, and evaluate `${property.Field}` (Camel Simple) instead of evaluating repeated XPath across multiple Router branches.
  - Order Router branches from most frequent to least frequent, and always define a `default` route on `<bpmn2:exclusiveGateway>`.
- All external endpoints must use `https://` and externalized parameters `{{PARAM_NAME}}`.
- All synchronous `ExternalCall` tasks must declare an explicit `timeout` property (e.g., `60000`).
- Every Script Task must reference `<ifl:property key="scriptFunction" value="processData"/>` and `<ifl:property key="script" value="<fileName>"/>`.
- Must include `<bpmndi:BPMNDiagram>` coordinates so the SAP CPI Web UI editor renders the diagram cleanly.

### Etapa 3: Scripts Groovy (`src/main/resources/script/*.groovy`)
Author each Groovy script planned in `groovyScriptsPlan[]` following all SAP CPI Scripting Guidelines (`def Message processData(Message message)`, `Reader` streaming, `JsonSlurperClassic`, `XmlSlurper` with `disallow-doctype-decl`, `ZoneId.of("UTC")`, conditional MPL attachments, `CPI-ERR:` exception rethrow).

### Etapa 4: Validación y Construcción de los Bundles OSGi (`.zip`)
Save your specification JSON (containing `iflowName`, `scriptCollectionName`, `businessDescription`, `parameters`, `iflwXml`, and `groovyScripts`) and execute `build-cpi-package.mjs`:

```bash
node ./scripts/build-cpi-package.mjs <spec.json | --demo> --out-dir ./dist-packages
```

* OSGi Packager & Validator script: [build-cpi-package.mjs](./scripts/build-cpi-package.mjs)
* OSGi Bundle Specification: [osgi-bundle-spec.md](./references/osgi-bundle-spec.md)
* **Verification Gate & OSGi Manifest Compliance**:
  - `build-cpi-package.mjs` validates both the `.iflw` BPMN2 XML and every Groovy script before producing `<iflowName>.zip`, `<scriptCollectionName>.zip`, and `Paquete_<iflowName>.zip`.
  - Places `.project` and `META-INF/MANIFEST.MF` **directly at the root of the `.zip`** (never nested inside a top-level wrapper folder) and wraps all `MANIFEST.MF` lines at **72 bytes UTF-8** with `\r\n ` continuations so SAP CPI never fails with `The project must contain a valid manifest file`.
  - Always remind the user to upload `<scriptCollectionName>.zip` (in *Add -> Script Collection*) and `<iflowName>.zip` (in *Add -> Integration Flow*) individually, rather than uploading the outer `Paquete_<iflowName>.zip` wrapper.

---

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
2. Asegúrate de que toda constante a nivel de script con `@Field` incluya `final` (`@Field final`), que el parseo XML deshabilite `disallow-doctype-decl`, y que el parseo JSON use `JsonSlurperClassic`.
3. Valida todos los scripts en lote con `validate-groovy.mjs`:

```bash
node ../sap-cpi-groovy-generator/scripts/validate-groovy.mjs <carpeta-scripts> --strict
```

### Paso 2: Clonar los iFlows y Empaquetar la Script Collection
Ejecuta `clone-iflow-bundle.mjs` para clonar cada iFlow de referencia (actualizando `.project`, `META-INF/MANIFEST.MF`, `metainfo.prop`, `<NuevoNombre>.iflw`, referencias a scripts `.groovy` y expresiones XPath del Splitter) y para inyectar los nuevos scripts en la Script Collection `.zip`:

```bash
# 1. Clonar y adaptar un iFlow .zip manteniendo intactos sus diagramas BPMN2 y .prop
node ./scripts/clone-iflow-bundle.mjs --source <Referencia_iFlow.zip> --target-name <Nuevo_iFlow> --out <Nuevo_iFlow.zip> --replace <ScriptViejo.groovy=ScriptNuevo.groovy> --xpath <//nodoViejo=//nodoNuevo>

# 2. Actualizar la Script Collection .zip con los nuevos scripts validados
node ./scripts/clone-iflow-bundle.mjs --update-sc <SC_Origen.zip> --scripts-dir <carpeta-scripts> --out <SC_Actualizada.zip> --strict
```

* Cloner & SC Updater script: [clone-iflow-bundle.mjs](./scripts/clone-iflow-bundle.mjs)
* **Normalización Automática de Estructura OSGi ZIP**: `clone-iflow-bundle.mjs` detecta y elimina automáticamente cualquier carpeta raíz intermedia heredada del `.zip` de origen (`stripRootFolderPrefix`), garantizando que `.project` y `META-INF/MANIFEST.MF` queden siempre en la raíz del `.zip` y con plegado de 72 bytes UTF-8 (`wrapManifestLine72`).
* Verifica finalmente todos los `.zip` generados ejecutando `inspect-iflow-zip.mjs` sobre cada paquete resultante (comprobando `manifestIssues: []`) e indica al usuario qué archivos `.zip` individuales debe subir en SAP CPI (*Script Collection* vs *Integration Flow*).
