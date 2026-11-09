# Base de Conocimiento y Lecciones Aprendidas (`LESSONS_LEARNED.md`)

Este documento constituye la memoria histórica viva de **`sap-cpi-skills-pack`**. Cada vez que se detecta un error real al importar o ejecutar un artefacto en SAP Cloud Integration (CPI / Integration Suite) o se incorpora un nuevo patrón arquitectónico, el agente registra aquí la lección **100% anonimizada** (sin datos de proyectos ni clientes) y la codifica en los validadores CLI.

---

## Registro de Lecciones Aprendidas

### `LL-001` — Error de Importación OSGi: `Upload the artifact failed. The project must contain a valid manifest file`
- **Síntoma en SAP CPI**: Al subir un archivo `.zip` (iFlow o Script Collection) en la web de SAP Integration Suite, la plataforma rechaza el paquete con el mensaje `Upload the artifact failed. The project must contain a valid manifest file`.
- **Causa Raíz Técnica**:
  1. El archivo `.zip` contenía una carpeta raíz intermedia (`MiCarpeta/META-INF/MANIFEST.MF`) en lugar de ubicar `META-INF/MANIFEST.MF` directamente en la raíz del archivo comprimido.
  2. La cabecera `Provide-Capability` en `META-INF/MANIFEST.MF` superaba los **72 bytes UTF-8 por línea** exigidos por la especificación OSGi / JAR (`java.util.jar.Manifest` / RFC 2822).
- **Solución Codificada**:
  - Se implementó `stripRootFolderPrefix()` y `wrapManifestLine72()` en `shared/zip-utils.mjs`, `skills/sap-cpi-architect/scripts/build-cpi-package.mjs` y `skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs`.
  - Se añadieron las reglas `MANIFEST_NOT_AT_ZIP_ROOT` y `MANIFEST_LINE_TOO_LONG` (`CRITICAL -30`) y la autorremediación `--remediate manifest` en `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`.

---

### `LL-002` — Error Runtime en Groovy: `No signature of method: java.io.BufferedReader.getText() / StringReader.getText() is applicable for argument types: (java.lang.String) values: [UTF-8]`
- **Síntoma en SAP CPI**: El iFlow falla en ejecución (`MissingMethodException`) dentro de un script Groovy al invocar `bodyReader.getText('UTF-8')` tras hacer `message.getBody(java.io.Reader)`.
- **Causa Raíz Técnica**: En Java y Groovy 2.4, las clases `Reader`, `BufferedReader` y `StringReader` ya son flujos de caracteres decodificados y su método `.getText()` **no acepta argumentos de charset** (a diferencia de `InputStream.getText('UTF-8')`).
- **Solución Codificada**:
  - Usar `bodyReader.getText()` sin argumentos, pasar el `Reader` directamente a `new JsonSlurper().parse(bodyReader)` / `new XmlSlurper().parse(bodyReader)`, o usar `message.getBody(String)`.
  - Se añadió la regla `READER_GETTEXT_CHARSET_ERROR` (`CRITICAL -30`) en `skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs`.

---

### `LL-003` — Error de Compilación en Groovy 2.4: `unable to resolve class groovy.xml.XmlSlurper`
- **Síntoma en SAP CPI**: El script Groovy falla durante la compilación inicial (`startup failed: unable to resolve class groovy.xml.XmlSlurper`).
- **Nota (corregida en `LL-017`)**: desde el Script step 2.0, SAP CPI también ofrece **Groovy 4**, donde ocurre justo lo contrario. La versión no se infiere: se indica con `--groovy 2.4|4`.
- **Causa Raíz Técnica**: El runtime Groovy 2.4 de SAP CPI, donde `XmlSlurper` y `XmlParser` pertenecen al paquete **`groovy.util.XmlSlurper`** y **`groovy.util.XmlParser`** (`groovy.xml.XmlSlurper` no existe en Groovy 2.4; Groovy 3 añadió `groovy.xml.*` manteniendo `groovy.util.*` como obsoleto, y Groovy 4 eliminó `groovy.util.Xml*`).
- **Solución Codificada**:
  - Importar siempre `groovy.util.XmlSlurper` y `groovy.util.XmlParser`.
  - Se añadió la regla `GROOVY24_INVALID_XMLSLURPER_IMPORT` (`CRITICAL -30`) en `skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs`.

---

### `LL-004` — Patrones de Handlers Centralizados, XSD Tolerante y `scriptBundleId`
- **Contexto**: Inspección de arquitecturas desacopladas con Handlers centrales de Error/Cloud Logging y refresco de Tokens OAuth.
- **Aprendizajes Incorporados**:
  1. **Handler Central de Errores (`ProcessDirect` + `Parallel Multicast`)**: Recibir eventos vía `ProcessDirect` y bifurcar con `ParallelGateway` hacia notificación de alerta (ej. Mail/Ticket) y observabilidad externa (HTTP/OpenSearch), marcando el MPL con `SAP_MessageProcessingLogCustomStatus`.
  2. **Handler Central de Tokens (`Timer` + `LocalIntegrationProcess` + Global `Data Store`)**: Refresco programado de credenciales OAuth almacenadas en un `DataStoreOperations` con `<value>global</value>` y `<value>true</value>` en `encrypt`.
  3. **XSD Envelope Tolerante**: En esquemas `.xsd` para Message Mapping de payloads dinámicos o logs, usar `minOccurs="0" nillable="true"` en campos hoja para evitar que la ausencia de un nodo aborte el mapeo.
  4. **Detección de `scriptBundleId`, `.mmap` y `.xsd`**: `inspect-iflow-zip.mjs` cataloga ahora mapeos gráficos (`.mmap`), esquemas (`.xsd`), colecciones externas referenciadas mediante `scriptBundleId` y posibles variables sin `def`/tipo en Groovy (`UNDECLARED_BINDING_VARIABLE`).

---

## Plantilla para Nuevas Lecciones

```markdown
### `LL-XXX` — <Título corto del error o patrón>
- **Síntoma en SAP CPI**: <Mensaje de error exacto o comportamiento observado>
- **Causa Raíz Técnica**: <Explicación técnica de por qué ocurre en SAP CPI>
- **Solución Codificada**: <Regla añadida en los scripts CLI y archivos actualizados>
```

---

### `LL-005` — Simulación Multi-Agente E2E (Contextos Aislados): Mapeos `.mmap`, Remediación de Timeouts y Paquetes Multi-Bundle
- **Contexto**: Prueba integral E2E ejecutada mediante 3 bots en contextos aislados (Bot 1: Especificación PDF, Bot 2: Arquitecto Constructor, Bot 3: Auditor y Remediador).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Mapeos Gráficos `.mmap` (`<xiObj>`)**: Creación de `skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs` con síntesis automática de bricks contenedores padre (`Constant`) para rutas destino anidadas (`/Root/Padre/Hijo`).
  2. **Cabeceras Estándar de Monitoreo en Groovy (`SAP_ApplicationID`)**: Se excluyeron `SAP_ApplicationID`, `SAP_Sender`, `SAP_Receiver`, `SAP_MessageType`, `SAP_MplCorrelationId` y `SAP_PregeneratedMplId` de la penalización `RESERVED_HEADER_MUTATION` en `validate-groovy.mjs`.
  3. **Bug de Lookahead Global en `--remediate timeouts`**: En `inspect-iflow-zip.mjs`, el reemplazo de timeouts ahora evalúa cada bloque `<bpmn2:serviceTask>` / `<bpmn2:callActivity>` de forma individual para que un `timeout` en un subproceso posterior no impida remediar una tarea anterior.
  4. **Auditoría Integrada de Groovy y Paquetes Multi-Bundle en PDF**: `inspect-iflow-zip.mjs` ejecuta ahora `lintGroovyScript` sobre todos los `.groovy` empaquetados, calcula correctamente el Score de paquetes compuestos (`Multi-Bundle Package`) y evita el solapamiento de títulos largos con el badge de Score en `shared/pdf-utils.mjs`.
  5. **Soporte de `filePath` / `iflwPath` en `build-cpi-package.mjs`**: Permite referenciar archivos `.iflw`, `.xsd`, `.mmap` y `.groovy` ya generados en disco sin necesidad de incrustar su texto completo dentro del JSON.

---

### `LL-006` — 5 Nuevas Extensiones de Alto Impacto: Simulación `.mmap`, Differ Semántico, Documentación Técnica en PDF, Exportación de Clientes API (Postman / OpenAPI) y Constructor de Value Mapping
- **Contexto**: Ampliación del ecosistema para dar soporte completo al ciclo de vida de desarrollo e integración sin dependencias externas:
  1. **Simulador Local de Mapeos Gráficos (`simulate-mmap.mjs` / MCP `cpi_simulate_mmap`)**: Permite simular y probar un mapeo gráfico `.mmap` (`<xiObj>`) de SAP CPI directamente en local frente a un payload XML o JSON de prueba, resolviendo árboles jerárquicos, constantes, cabeceras HTTP/Camel y propiedades del Exchange sin requerir despliegue en CPI. El parser implementa un escáner balanceado de profundidad para etiquetas `<brick>` anidadas.
  2. **Differ Semántico de Bundles iFlow (`diff-iflow-zip.mjs` / MCP `cpi_diff_bundles`)**: Compara semánticamente dos paquetes `.zip` ignorando el ruido gráfico de coordenadas BPMNDI (`BPMNDiagram`/`BPMNShape`), detectando modificaciones en `parameters.prop` (checklist de despliegue entre ambientes), recursos añadidos/modificados y delta de score de gobernanza con informe PDF comparativo.
  3. **Generador de Diseño Técnico en PDF de 8 Secciones (`extract-for-docs.mjs --pdf` / MCP `cpi_export_technical_doc`)**: Exporta el Documento de Diseño Técnico corporativo oficial con las 8 secciones obligatorias (Resumen Ejecutivo, Arquitectura BPMN 2.0, Contratos XSD/WSDL, Mappings, Scripts Groovy, Parámetros Externalizados, Canales Adaptadores y Manejo de Errores) en formato PDF nativo de alta resolución.
  4. **Generador de Clientes API Postman & OpenAPI (`export-api-client.mjs` / MCP `cpi_export_api_client`)**: Inspecciona automáticamente los canales receptores de entrada (HTTPS/SOAP/OData/AS2), infiere la estructura del cuerpo desde los esquemas XSD empaquetados y genera colecciones Postman v2.1 (con handshake automático para obtención de `x-csrf-token`) y especificaciones OpenAPI 3.0.3.
  5. **Constructor de Paquetes OSGi de Value Mapping (`build-value-mapping.mjs` / MCP `cpi_build_value_mapping`)**: Construye archivos `.zip` de Value Mapping 100% compatibles con SAP Integration Suite a partir de esquemas JSON o tablas CSV, configurando `.project` con las naturalezas `com.sap.ide.ifl.valmap`, `com.sap.ide.ifl.project.support.project.nature` y `org.eclipse.jdt.core.javanature`, `META-INF/MANIFEST.MF` plegado a 72 bytes con `SAP-BundleType: ValueMapping`, `metainfo.prop` y `value_mapping.xml` (formato corregido en `LL-016`).

---

### `LL-007` — Normalización de Payloads JSON en Suites de Mock Data, Propagación de Warnings en Inferencia XSD y Clasificación OSGi de Value Mapping en Zip Inspector
- **Contexto**: Fase 1 de modelado de contratos E2E y baterías de prueba integral (B2B Order Processing con StorefrontOrder, CustomerLookup y Value Mapping S/4HANA).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Normalización de Payloads JSON en `pack-mock-suite.mjs`**: Se resolvió la excepción `TypeError: (content || "").trim is not a function` cuando la especificación JSON contiene ejemplos como objetos JSON nativos en lugar de cadenas escapadas. Ahora `parseMockSuiteInput` y `validateSingleSample` serializan y validan transparentemente objetos y arrays.
  2. **Claves de Correlación E2E Dinámicas**: `pack-mock-suite.mjs` ahora respeta la propiedad `correlationKeys: [...]` de la especificación JSON y el argumento CLI `--correlateKey`, unificándolos con los identificadores canónicos de SAP ERP/CPI (`orderId`, `customerId`, `partnerId`, `invoiceNumber`, `docnum`, `kunnr`).
  3. **Visibilidad de Warnings y Errores en Inferencia XSD (`validate-xsd.mjs`)**: En modo `--infer`, el CLI ahora imprime explícitamente en consola cualquier advertencia (ej. `nillable="true"` o `elementFormDefault`) o error de validación antes de finalizar la ejecución.
  4. **Auditoría OSGi de Value Mapping en `inspect-iflow-zip.mjs`**: Se incorporó el reconocimiento de paquetes `ValueMapping` (`SAP-BundleType: ValueMapping` o presencia de `value_mapping.xml`), asignándoles una auditoría de empaquetado OSGi (100/100 base) y eliminando falsos positivos críticos por ausencia de `.iflw` o Exception Subprocess.

---

### `LL-008` — Flexibilidad de Parámetros CLI en Transformación y Simulación: Propiedades Camel Simple (`--prop`), Headers/Props Dinámicos en Simulador `.mmap` y Parsing Posicional en Validador XSLT
- **Contexto**: Fase 2 de batería de pruebas integral en contextos aislados (Bot 2: Transformación y Scripting Groovy/XSLT).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Soporte de Exchange Properties y Headers en `test-camel-regex.mjs`**: Se incorporaron los argumentos CLI `--prop`, `--property` y `--header` (con soporte para sintaxis `flag valor` y `flag=valor`), generando automáticamente expresiones Apache Camel Simple normalizadas (`${exchangeProperty.VariableName}` y `${header.VariableName}`) además de `--field`.
  2. **Inyección Dinámica Multi-Formato en `simulate-mmap.mjs`**: Los argumentos `--headers` y `--properties` ahora aceptan tanto rutas a archivos `.json` existentes como cadenas JSON directas (ej. `'{"CamelHttpMethod":"POST"}'`) o listas de pares clave=valor (`CamelHttpMethod=POST,Content-Type=application/json`), facilitando la automatización en pipelines CI/CD y tests interactivos.
  3. **Parsing Agnóstico al Orden y Alias de Versión en `validate-xslt.mjs`**: Se flexibilizó el análisis de argumentos en CLI para aceptar la ruta del archivo XSLT en cualquier posición (antes o después de flags), soportando `--version=2.0` / `--version 2.0` como alias de `--engine` y gestionando metadatos de contexto como `--scenario`.

---

### `LL-009` — Inbound API Client Generator (Postman v2.1 & OpenAPI 3.0): Pre-Request Script para Handshake CSRF Automático, Soporte `--base-url`, Resolución de Parámetros Externalizados y Payloads Duales (XML/JSON)
- **Contexto**: Fase 3 de batería de pruebas integral en contextos aislados (Bot 3: Arquitecto de Integración y Empaquetado OSGi con iFlow `IF_B2B_OrderProcessing`, Script Collection `SC_B2B_OrderProcessing`, Clonación v2 y Generación de Clientes API).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Pre-Request Script para Handshake CSRF Automático en Postman**: Anteriormente, `export-api-client.mjs` únicamente generaba una petición GET independiente ("1. Fetch X-CSRF-Token") sin pre-request script en la petición principal POST, lo que obligaba al usuario a ejecutar manualmente la primera petición antes de enviar el mensaje o fallaba en suites automatizadas Newman/CI/CD. Se programó un `prerequest` script en la petición POST ("2. Send Message") que utiliza `pm.sendRequest` con método `GET` y cabecera `X-CSRF-Token: Fetch` para auto-poblar dinámicamente `cpi_csrf_token` sin intervención manual, manteniendo además la petición independiente para inspección interactiva.
  2. **Soporte CLI `--base-url` y Sincronización con Servidor OpenAPI**: Se agregó el argumento CLI `--base-url <url>` en `export-api-client.mjs` (y su propagación desde `mcp-server.mjs`), permitiendo configurar la URL base del tenant SAP CPI (ej. `https://<tenant>-iflmap.hcisbp.eu10.hana.ondemand.com`) en la variable de entorno de Postman (`CPI_TENANT_BASE_URL`) y en el bloque `servers` de la especificación OpenAPI 3.0.3.
  3. **Resolución de Endpoints Externalizados desde `parameters.prop`**: Cuando el canal remitente del BPMN2 `.iflw` utiliza parámetros externalizados en la dirección (ej. `{{StorefrontEndpoint}}`), `extractInboundEndpointsFromIflw` ahora resuelve automáticamente la clave leyendo `parameters.prop` dentro del paquete `.zip`, generando URLs limpias y operativas (ej. `/cpi/b2b/orders`) en lugar de rutas con sintaxis cruda `{{...}}`.
  4. **Payloads de Muestra Duales (XML y JSON) en OpenAPI 3.0.3**: Se añadió `synthesizeSampleJsonFromXsd` para generar automáticamente esquemas y ejemplos tanto en `application/xml` como en `application/json` en `requestBody.content`, cubriendo los dos formatos estándar consumidos por adaptadores HTTP/REST de SAP CPI.

---

### `LL-010` — Gobernanza, Auditoría CPILint y Generación Dual de Documentación Técnica (Markdown & PDF): Extracción CLI `--markdown`, Enriquecimiento de Contratos en Arquitectura y Verificación E2E de Herramientas MCP
- **Contexto**: Fase 4 de la batería de pruebas integral en contextos aislados (Bot 4: Auditor de QA, Seguridad, Remediación y Gobernanza con validación de bundles `IF_B2B_OrderProcessing.zip`, `IF_B2B_OrderProcessing_Flawed.zip`, `IF_B2B_OrderProcessing_Remediated.zip`, `IF_B2B_OrderProcessing_v2.zip` y llamadas JSON-RPC 2.0 al servidor MCP).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Generación Dual CLI de Documentación Técnica (`extract-for-docs.mjs --markdown / --md`)**: Anteriormente, el script CLI de ingeniería inversa `extract-for-docs.mjs` únicamente persistía archivos en disco cuando se pasaba la opción `--pdf`, obligando a usar APIs programáticas o el servidor MCP para obtener el archivo Markdown correspondiente. Se añadieron los flags CLI `--markdown <doc.md>` y `--md <doc.md>`, permitiendo emitir tanto el PDF oficial de 8 secciones como el Markdown en una única llamada determinista para validación inmediata con `--validate-doc`.
  2. **Enriquecimiento Arquitectónico en Sección 2 (`Arquitectura del Flujo`)**: El generador de documentación técnica en Markdown ahora extrae e indexa explícitamente en la Sección 2 los contratos de interfaz y esquemas XSD/WSDL empaquetados (`StorefrontOrder.xsd`, `S4SalesOrder.xsd`) junto con los mapeos gráficos y transformaciones (`.mmap`, `.xsl/.xslt`), mejorando la completitud técnica corporativa de los informes entregables.
  3. **Indexación de Scripts Referenciados en Sección 4 (`Scripts Groovy / Script Collection`)**: Cuando un iFlow consume scripts Groovy desacoplados desde una Script Collection compartida (sin scripts `.groovy` locales en el bundle), la documentación técnica ahora reporta las referencias detectadas en el `.iflw` (ej. `EnrichOrderRefactored.groovy`) en lugar de reportar falsamente la ausencia total de lógica Groovy.
  4. **Validación E2E Determinista del Servidor Local MCP (`mcp-server.mjs`)**: Se validó el protocolo JSON-RPC 2.0 en 5 herramientas clave (`cpi_inspect_zip`, `cpi_diff_bundles`, `cpi_export_technical_doc`, `cpi_simulate_mmap`, `cpi_build_value_mapping`) sobre artefactos reales de la batería, certificando cero errores `{ isError: false }` y generación efectiva de PDFs, XMLs y ZIPs en disco.

---

### `LL-011` — Expansión MCP a 20 Herramientas Granulares: Mock Suite Packaging, Matriz de Endpoints Inbound/Outbound, Lector de Archivos en Memoria y Plantillas Canónicas Groovy 100/100
- **Contexto**: Solicitud de granularidad técnica avanzada en el servidor MCP local para responder a consultas específicas de desarrollo e integración sin requerir flujos de trabajo monolíticos.
- **Aprendizajes y Correcciones Codificadas**:
  1. **Empaquetador de Suites de Mock Data en MCP (`cpi_pack_mock_suite`)**: Se completó la cobertura 100% de las 8 skills en MCP exponiendo la generación de suites de prueba E2E con correlación de identificadores cruzados (Request, Response, Lookup, Error) en archivos `.zip` o JSON.
  2. **Matriz Concisa de Conectividad (`cpi_get_iflow_endpoints`)**: Se incorporó un extractor de endpoints de alta velocidad que aísla canales remitentes (inbound) y destinatarios (outbound), discriminando adaptadores (HTTPS, SOAP, ProcessDirect, OData, SFTP), resolviendo parámetros externalizados desde `parameters.prop` y auditando políticas de protección CSRF y timeouts.
  3. **Lector de Archivos en Memoria sin Descompresión en Disco (`cpi_extract_bundle_file` & `shared/zip-utils.mjs`)**: Se implementó `extractBundleFile` para extraer el contenido textual exacto de cualquier recurso dentro de un `.zip` (`.groovy`, `.xsd`, `.mmap`, `.prop`, `MANIFEST.MF`) mediante coincidencia exacta o expresión regular, evitando escrituras temporales en el sistema de archivos.
  4. **Generador Determinista de Plantillas Groovy Canónicas (`cpi_generate_groovy_template` & `validate-groovy.mjs --template`)**: Se codificó la generación de 6 plantillas de producción con calificación garantizada de 100/100 para patrones de uso intensivo en SAP CPI: `json-streaming`, `xml-slurper`, `mpl-custom-headers`, `oauth-token-inject`, `dynamic-routing-header` y `base64-attachment`.
  5. **Habilitación de Cabeceras Dinámicas en Auditoría Groovy**: Se incorporó `SAP_MessageProcessingLogCustomStatus` a la lista de cabeceras SAP mutables de forma segura (`writableSapHeaders`), así como las cabeceras de enrutamiento dinámico Camel (`CamelProcessDirectAddress`, `CamelHttpUri`, `CamelHttpPath`), evitando penalizaciones de `RESERVED_HEADER_MUTATION` en lógica estándar de negocio.
  6. **Sanitización de Modos CLI en `build-value-mapping.mjs`**: Se ajustó la emisión por defecto de archivos zip para que en ejecuciones de auto-verificación con `--json` no se escriban archivos residuales en el directorio de trabajo sin un flag `--out` explícito.

---

### `LL-012` — Extracción Resiliente de Recursos en Bundles ZIP en Memoria (`extractBundleFile` / `cpi_extract_bundle_file`): Soporte Dual Wildcard/Glob y Expresiones Regulares, Fallback Inteligente por Basename y Resiliencia Total ante Insumos Inválidos o Corruptos
- **Contexto**: Fase de verificación exhaustiva de la herramienta MCP granular `cpi_extract_bundle_file` y la función compartida `extractBundleFile` en `shared/zip-utils.mjs` (Bot 7: Tester de Extracción de Bundles en Memoria sobre iFlow `IF_B2B_OrderProcessing.zip`, Script Collection `SC_B2B_OrderProcessing.zip` y Value Mapping `VM_DeliveryStatus_S4.zip`).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Soporte Nativo de Comodines Glob (`*.ext`, `?`) y Regex (`.*\.ext`, `^...$`)**: Anteriormente, `extractBundleFile` utilizaba `String.prototype.includes()` para búsquedas no exactas, lo cual fallaba al evaluar patrones con comodines (ej. `*.iflw`) o expresiones regulares. Se incorporó resolución sintáctica con compilación dinámica de glob (`*.iflw` -> `/^.*\.iflw$/i`) y soporte explícito para expresiones regulares, permitiendo al desarrollador o cliente MCP ubicar artefactos sin conocer de antemano el nombre exacto o la ruta profunda de carpetas.
  2. **Fallback Inteligente por Nombre Base (`basename`)**: Si una consulta especifica una ruta con prefijo divergente (ej. `scenarioflows/zerocode/...` en lugar de `scenarioflows/integrationflow/...`), el extractor resuelve la coincidencia por `basename` si el archivo existe de forma inequívoca en el paquete, facilitando la inspección de flujos independientemente de la convención interna de carpetas.
  3. **Resiliencia Total y Contrato Homogéneo de Error (`{ success: false, found: false, error: ... }`)**: Se encapsuló la lectura del ZIP y parsing del Central Directory en bloques protegidos contra archivos inexistentes en disco (ENOENT) y buffers binarios truncados o corruptos, retornando siempre un objeto estructurado de fallo controlado sin lanzar excepciones no controladas hacia el runtime o el servidor MCP.
  4. **Paridad de Integridad de Datos (Bit-by-Bit)**: Se validó que el texto y tamaño extraído en memoria preserva exactamente la fidelidad de los datos descomprimidos del Central Directory, garantizando que scripts Groovy, esquemas XML/XSD, Value Mappings y propiedades de configuración se recuperen íntegros sin alteraciones.

---

### `LL-013` — Extracción Robusta de Endpoints de Conectividad iFlow (`extractIflowEndpointsSummary` / `cpi_get_iflow_endpoints`): Resolución In-Memory de Parámetros Externalizados, Detección CSRF (`isCsrfProtected`), Clasificación Estricta Sender/Receiver y Manejo Elegante de Ausencia de `.iflw` (Script Collections)
- **Contexto**: Fase de verificación de conectividad y endpoints iFlow (Bot 6: Tester Conectividad y Endpoints iFlow en batería integral sobre `IF_B2B_OrderProcessing.zip`, `IF_B2B_OrderProcessing_v2.zip`, `IF_B2B_OrderProcessing_Flawed.zip` y `SC_B2B_OrderProcessing.zip`).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Resolución In-Memory de Parámetros Externalizados desde `parameters.prop`**: Anteriormente, `extractParametersMap` leía exclusivamente `propEntry.text`, el cual no está presente en el catálogo de `inspectBundle` (`propEntry.content`), provocando que los parámetros externalizados `{{...}}` no se resolvieran y quedaran como mapas vacíos. Se corrigió para leer `propEntry.content || propEntry.text` y se activó la opción `{ showPropValues: true }` en memoria para `extractIflowEndpointsSummary` y `exportApiClientContracts`, logrando que direcciones y timeouts (ej. `{{S4_Endpoint}}`, `{{S4_Timeout}}`) se resuelvan con fidelidad total a sus valores reales.
  2. **Detección Explícita de Protección CSRF (`isCsrfProtected`)**: Se expuso la propiedad `isCsrfProtected` (además de la existente `xsrfProtection`) tanto en canales inbound como en especificaciones de cliente, permitiendo auditorías directas de seguridad y handshake de tokens CSRF.
  3. **Clasificación Estricta Sender / Receiver mediante Parseo de Participantes BPMN2**: Se añadió `parseParticipants` para registrar los identificadores de participantes `EndpointSender` y `EndpointRecevier`/`EndpointReceiver` del tag `<bpmn2:participant>`, garantizando que ningún canal saliente/receptor sea clasificado jamás erróneamente en `inboundEndpoints`.
  4. **Manejo Elegante de Paquetes sin Definición BPMN2 (`.iflw`)**: Al inspeccionar artefactos ZIP que carecen de `.iflw` (como `SC_B2B_OrderProcessing.zip` o Value Mappings), la función retorna de inmediato `{ valid: false, error: ... }` con totales en 0 y arrays vacíos, sin fabricar endpoints sintéticos de fallback ni lanzar excepciones no capturadas.
  5. **Comando CLI `--endpoints`**: Se integró soporte directo para la bandera CLI `--endpoints [--json]` en `export-api-client.mjs`, permitiendo a operadores de consola inspeccionar la matriz de conectividad en una línea sin necesidad de generar colecciones Postman completas.


---

### `LL-014` — Generador Determinista de Plantillas Canónicas Groovy 100/100 (`cpi_generate_groovy_template` & `validate-groovy.mjs --template`): Validación Estricta de Patrones, Lectura Cross-Platform Anti-BOM/UTF-16LE y Modo `customComments`
- **Contexto**: Batería de pruebas exhaustiva de la herramienta MCP `cpi_generate_groovy_template` y la opción CLI `--template` en `validate-groovy.mjs` (Bot 5: Tester Groovy Templates 100/100 sobre los 6 patrones arquitectónicos de SAP CPI).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Validación Estricta de Patrones Canónicos y Control de Límites (`CANONICAL_PATTERNS`)**: Se codificó la lista explícita de los 6 patrones canónicos soportados (`json-streaming`, `xml-slurper`, `mpl-custom-headers`, `oauth-token-inject`, `dynamic-routing-header`, `base64-attachment`). Cuando se solicita un patrón inválido (ej. `invalid-pattern-xyz`), la función y el CLI terminan de forma controlada con código de salida 1 y emiten el listado de patrones válidos disponibles.
  2. **Lectura Segura y Detección Automática de Codificación (`readTextFileSafely`)**: Al redirigir salidas en consolas Windows/PowerShell (`>`), los archivos suelen guardarse con codificación UTF-16LE o con BOM (`0xFF 0xFE` o `0xEF 0xBB 0xBF`), provocando que lectores UTF-8 estándar fallen por caracteres nulos interpolados. Se implementó `readTextFileSafely` en `validate-groovy.mjs` y `audit-groovy.mjs`, detectando automáticamente la firma de bytes y decodificando transparentemente UTF-16LE, UTF-16BE y UTF-8.
  3. **Comentarios de Cumplimiento Arquitectónico (`customComments: true`)**: Se enriquecieron las 6 plantillas para soportar la opción `customComments: true` tanto en el CLI (`--comments`) como a través de la herramienta MCP `cpi_generate_groovy_template`. Cada script incluye comentarios detallados de directrices oficiales de SAP CPI (streaming anti-OOM, prevención XXE, observabilidad en MPL, manipulación de fechas en UTC y enrutamiento dinámico) garantizando una puntuación perfecta de 100/100 y 0 hallazgos en `validate-groovy` y `audit-groovy`.
  4. **Formato de Salida CLI Compatible con Compilación (`// ===`)**: La cabecera informativa emitida por el CLI `--template` fue adaptada a comentarios de una línea (`// === ...`), permitiendo que el archivo generado sea inmediatamente sintácticamente válido para cualquier compilador o analizador de Groovy sin necesidad de preprocesamiento.

---

### `LL-015` — Empaquetado y Correlación E2E de Suites de Mock Data Multicontrato (`cpi_pack_mock_suite` / `pack-mock-suite.mjs`): Índice Estructurado `mock-suite-index.json`, Resiliencia de Contratos y Detección de Desajustes
- **Contexto**: Batería de pruebas exhaustiva de la herramienta MCP `cpi_pack_mock_suite` y el script CLI determinista `pack-mock-suite.mjs` (Bot 8: Tester MCP Mock Data E2E sobre contratos cruzados `StorefrontOrder` JSON, `CustomerLookupResponse` JSON y `S4SalesOrderConfirmation` XML).
- **Aprendizajes y Correcciones Codificadas**:
  1. **Manifiesto e Índice Estructurado en ZIP (`mock-suite-index.json`)**: Además del archivo de auditoría textual `README_SUITE.txt`, se implementó la generación automática del índice estructurado `mock-suite-index.json` en la raíz del archivo ZIP de la suite. Este índice detalla la metadata del lote, contratos, carpetas, archivos de prueba por extensión y la relación de claves foráneas sincronizadas.
  2. **Validación Defensiva de Especificaciones JSON y Control de Errores MCP**: Se blindó `parseMockSuiteInput` y el manejador `cpi_pack_mock_suite` en `mcp-server.mjs` para rechazar especificaciones vacías o malformadas (ej. `{ name: "broken" }` sin `payloads` ni `contracts` o `{}`) emitiendo `{ isError: true }` y descripciones operativas claras en el estándar JSON-RPC 2.0 en lugar de excepciones no capturadas.
  3. **Soporte Paramétrico Dual (`outZipPath` y `outputZipPath`)**: Se habilitó compatibilidad total para las dos convenciones de nomenclatura en argumentos MCP (`outputZipPath` y `outZipPath`), asegurando persistencia en disco y reporte consistente de rutas absolutas.
  4. **Matriz de Correlación E2E Multicontrato (`correlations`)**: Se enriqueció el retorno de `validateAndBuildMockSuiteZip` para incluir un desglose estructurado `correlations` con las claves verificadas (`orderId`, `customerId`, etc.), su valor sincronizado y la lista de contratos vinculados, verificando la ausencia total de advertencias en contratos consistentes y advirtiendo inmediatamente en caso de inconsistencia de claves.

---

### `LL-016` — Endurecimiento P0: seguridad de ZIP, privacidad de `.prop`, MCP fuera del cwd y formatos reales de `.project` / Value Mapping
- **Síntoma**: (1) los scripts CLI no se ejecutaban como `main` en Windows ni con rutas con espacios o enlaces simbólicos; (2) el servidor MCP terminaba con `CONNECTION_CLOSED` al lanzarse desde un directorio distinto al del repo; (3) un `.zip` con entradas `../` podía escribir fuera del directorio de extracción, y un zip-bomb podía agotar la memoria; (4) los valores de `parameters.prop` aparecían en la salida del extractor, en el differ y en las colecciones Postman; (5) el MANIFEST reparado o clonado perdía las secciones `Name:` y corrompía cabeceras plegadas, y el renombrado por subcadena dañaba identificadores; (6) los `.project` y paquetes Value Mapping generados no coincidían con los que exporta SAP.
- **Causa Raíz Técnica**: comparación ingenua de `import.meta.url` con `argv[1]`; rutas relativas al cwd en la configuración MCP; ausencia de validación de rutas y de límites al leer ZIP; impresión literal de `.prop`; reescritura del MANIFEST línea a línea sin unfold; plantillas de `.project` y `value_mapping.xml` no verificadas.
- **Solución Codificada**:
  - `shared/cli-utils.mjs` (`isMainModule`, `moduleDir`). `setup-skills.mjs` escribe ruta absoluta en `.mcp.json` (Claude Code también hereda `.mcp.json` de carpetas padre, donde `${CLAUDE_PROJECT_DIR}` apuntaría a la subcarpeta y causaría `CONNECTION_CLOSED`) y `${workspaceFolder}` en `.vscode/mcp.json` y fusiona JSONC con copia `.bak`.
  - `shared/zip-utils.mjs`: `sanitizeEntryPath`, `resolveInside`, `ZIP_LIMITS` y redacción `[REDACTED]` de `.prop` (salvo `metainfo.prop`), con opt-in `showPropValues` / `--resolve-params`.
  - `mcp-server.mjs`: toda ruta de usuario pasa por `resolveUserPath`, restringida a las raíces permitidas: `CPI_MCP_ROOT` (o `CLAUDE_PROJECT_DIR` / cwd), el directorio temporal del sistema y `CPI_MCP_ALLOWED_ROOTS` (lista separada por el delimitador de rutas del SO). `CPI_MCP_UNSAFE_PATHS=1` desactiva la restricción.
  - `shared/safe-regex.mjs`: las regex de usuario (extractor y `test-camel-regex`) se evalúan en sandbox con timeout (anti-ReDoS).
  - `shared/manifest-utils.mjs`: unfold → transformar → refold a 72 bytes, conservando las secciones `Name:`. El clonador renombra solo identificadores completos.
  - `.project` real: buildCommand `org.eclipse.jdt.core.javabuilder` y naturalezas `org.eclipse.jdt.core.javanature`, `com.sap.ide.ifl.project.support.project.nature` y `com.sap.ide.ifl.bsn` (iFlow / Script Collection) o `com.sap.ide.ifl.valmap` (Value Mapping).
  - Value Mapping: `<vm version="2.0"><group id="<hex32>"><entry><agency/><schema/><value/></entry>…</group></vm>` (`isDefault="true"` opcional) y MANIFEST con `Import-Package: com.sap.xi.mapping.camel.valmap` y `Bundle-Activator: com.sap.xi.mapping.camel.valmap.ValueMappingActivator`.
  - Timeouts: `httpRequestTimeout` solo en el `messageFlow` HTTP; el resto de adaptadores se reporta. Se eliminó la reescritura automática de XmlSlurper/XmlParser durante la remediación.
  - Basic Auth (`IFLW-008`) por canal, con las claves reales de cada adaptador y exención `proxyType=sapcc`.
- **Archivos**: `shared/*.mjs`, `mcp-server.mjs`, `setup-skills.mjs`, `inspect-iflow-zip.mjs`, `diff-iflow-zip.mjs`, `export-api-client.mjs`, `clone-iflow-bundle.mjs`, `build-cpi-package.mjs`, `build-value-mapping.mjs`, `test-camel-regex.mjs`.

---

### `LL-017` — Groovy 2.4 vs Groovy 4 (Script step 2.0) y Camel Simple `${exchangeProperty.X}`
- **Síntoma**: falsos CRITICAL/HIGH sobre `groovy.util.XmlSlurper` o `groovy.xml.XmlSlurper` según la API `Message` importada, y presets de regex con `${property.X}`.
- **Causa Raíz Técnica**: la versión de Groovy (2.4 o 4) es una propiedad del paso Script del iFlow, no de la API `Message` v1/v2, así que no puede deducirse del código. Groovy 2.4 no tiene `groovy.xml.XmlSlurper` y Groovy 4 ya no tiene `groovy.util.XmlSlurper`. En Camel 3 (runtime de CPI) se eliminó `${property.X}` en favor de `${exchangeProperty.X}`. `${in.body}` está deprecado pero funciona; se recomienda `${body}`.
- **Solución Codificada**: `validate-groovy.mjs` acepta `--groovy 2.4|4` (y `groovyVersion` en las herramientas MCP `cpi_validate_groovy` / `cpi_audit_groovy`) con las reglas `GROOVY24_INVALID_XMLSLURPER_IMPORT`, `GROOVY4_REMOVED_GROOVY_UTIL_XML`, `GROOVY4_CAMEL_IMPORT` y `GROOVY4_DATE_EXTENSIONS`. Sin versión, solo emite `GROOVY_VERSION_DEPENDENT_XML_API` (MEDIUM). La plantilla `xml-slurper` genera `groovy.xml.XmlSlurper` para Groovy 4 (por defecto con `--api v2`) y `groovy.util.XmlSlurper` para Groovy 2.4. Los presets y la SKILL de regex usan `${exchangeProperty.X}`.
- **Archivos**: `validate-groovy.mjs`, `mcp-server.mjs`, `regex-presets.md`, `sap-cpi-regex-studio/SKILL.md`, `sap-cpi-architect/SKILL.md`, `docs/VALIDATION_RULES.md`.

---

### `LL-018` — Ubicación de `value_mapping.xml` y cabeceras del bundle Value Mapping
- **Síntoma**: había dudas sobre si `value_mapping.xml` va en la raíz del bundle o en una subcarpeta (p. ej. `src/main/resources/`), y sobre las cabeceras mínimas del MANIFEST.
- **Causa Raíz Técnica**: el ejemplo oficial de SAP (`TestValueMap.zip`, adjunto a la guía "Accessing valueMaps from a script" del SAP Business Accelerator Hub) contiene solo 3 entradas: `value_mapping.xml` **en la raíz**, `META-INF/MANIFEST.MF` y `.project`. Su MANIFEST declara `SAP-BundleType: ValueMapping`, `SAP-NodeType: IFLMAP`, `Bundle-Activator: com.sap.xi.mapping.camel.valmap.ValueMappingActivator`, `Import-Package: com.sap.xi.mapping.camel.valmap` y `Bundle-SymbolicName: <Nombre>; singleton:=true`. Ese ejemplo (antiguo) usa la naturaleza `com.sap.ide.ifl.bsn` en `.project`; las exportaciones más recientes usan `com.sap.ide.ifl.valmap`. La importación la determina `SAP-BundleType`, no la naturaleza. `metainfo.prop` es opcional.
- **Solución Codificada**: `build-value-mapping.mjs` mantiene `value_mapping.xml` en la raíz y ahora emite `Bundle-SymbolicName: <Nombre>; singleton:=true`. Por convención, el Value Mapping se crea en el mismo paquete de integración que el iFlow que lo usa. Aun así, en runtime los pares agencia/identificador son globales al tenant: deben ser únicos entre todos los Value Mappings desplegados (si se duplican, falla `ValueMappingActivator.start()`).
- **Archivos**: `build-value-mapping.mjs`, `sap-cpi-architect/SKILL.md`.

---

### `LL-019` — Contrato MCP: `required`, errores JSON-RPC y raíz fija del sandbox
- **Síntoma**: 13 herramientas aceptaban `{}` (p. ej. `cpi_inspect_zip {}` auditaba el demo en silencio). JSON malformado, `null` o un batch se descartaban sin respuesta. Con el cliente arrancado desde `$HOME` o `C:\`, el "workspace" era todo el disco. `extractDir` escribía `parameters.prop` en claro.
- **Causa Raíz Técnica**: el servidor no aplicaba `inputSchema.required` ni los tipos, no implementaba los códigos JSON-RPC 2.0 (`-32700`, `-32600`, `-32601`, `-32602`) y tomaba el cwd como raíz cuando no había `CPI_MCP_ROOT`.
- **Solución Codificada**: `validateToolArguments` (campos obligatorios y tipos, con `-32602`), `handleJsonRpcPayload` (batches, `-32700`/`-32600`), negociación de `protocolVersion` (`SUPPORTED_PROTOCOL_VERSIONS`) y errores JSON-RPC para tool/resource/prompt desconocidos. `setup-skills.mjs --mcp` escribe `env.CPI_MCP_ROOT` en `.mcp.json`. La extracción vía MCP redacta los `.prop` (`redactExtractedProps`).
- **Archivos**: `mcp-server.mjs`, `setup-skills.mjs`, `inspect-iflow-zip.mjs`.

---

### `LL-020` — Las regex de CPI son Java, no JavaScript, y Camel Simple distingue mayúsculas
- **Síntoma**: el sandbox rechazaba regex Java válidas (`(?i)`, `a++`, `\Q..\E`, `\p{L}`). `^(a|aa)+$` solo se marcaba como ReDoS con entradas largas. No se avisaba de `${property.X}`, `${In.Body}` ni `${in.body}`.
- **Causa Raíz Técnica**: el router y los Content Modifier de CPI usan `java.util.regex`. Los flags inline, los cuantificadores posesivos, `\Q..\E` y las clases Unicode deben traducirse antes de evaluarse en V8. La alternancia solapada dentro de un cuantificador es ReDoS aunque no haya cuantificadores anidados. En Camel 3 `${property.X}` no existe y `${in.body}` está obsoleto.
- **Solución Codificada**: `shared/java-regex.mjs` con `translateJavaRegex`, `findOverlappingAlternation` (análisis estático) y `checkCamelSimpleField`, usados por `test-camel-regex.mjs`.
- **Archivos**: `shared/java-regex.mjs`, `test-camel-regex.mjs`, `sap-cpi-regex-studio/SKILL.md`.

---

### `LL-021` — Diff de bundles por hash y remediación de timeouts por `sourceRef` o `targetRef`
- **Síntoma**: un cambio de igual longitud (timeout 1000→2000) salía como "0 modificados" y el PDF decía "idénticos". No se listaban los pasos añadidos o eliminados. Los canales enlazados solo por `targetRef` no recibían el timeout.
- **Causa Raíz Técnica**: la comparación usaba el tamaño de la entrada. Un canal receptor de un Request-Reply puede referenciar la tarea como `sourceRef` o como `targetRef`.
- **Solución Codificada**: `diff-iflow-zip.mjs` compara por hash de contenido y añade `extractIflowSteps` (pasos añadidos/eliminados, parámetros eliminados y versión del manifest también en consola/PDF). La remediación y la auditoría resuelven el canal por ambos atributos. El DEMO del architect pone el timeout en el canal.
- **Archivos**: `diff-iflow-zip.mjs`, `inspect-iflow-zip.mjs`, `build-cpi-package.mjs`.

---

### `LL-022` — Architect: CSV de Value Mapping, `urlPath` del sender HTTPS y escapado de `.prop`
- **Síntoma**: el CSV con comillas o con `;` daba stack trace y los duplicados pasaban sin aviso. `export-api-client` ignoraba `urlPath` (salía `/cpi/inbound`) y aceptaba una Script Collection. `build-cpi-package` escribía el zip aunque fallara y no escapaba saltos de línea en `parameters.prop`/`.propdef`.
- **Causa Raíz Técnica**: el sender HTTPS guarda su ruta en `urlPath`; SOAP/IDoc/ProcessDirect usan `address`. Los `.prop` son `java.util.Properties`: `\`, `=`, `:` y los saltos de línea deben escaparse.
- **Solución Codificada**: `detectCsvDelimiter` y `parseCsvRows` (RFC 4180, avisos de duplicados agencia/valor), `classifyMessageFlow` y rechazo de bundles que no son iFlow, `escapePropKey`/`escapePropValue`/`escapeXmlText` y "nada se escribe si hay errores". El clonador actualiza las referencias a scripts renombrados.
- **Archivos**: `build-value-mapping.mjs`, `export-api-client.mjs`, `build-cpi-package.mjs`, `clone-iflow-bundle.mjs`.

---

### `LL-023` — XSD con parser real e inferencia saneada
- **Síntoma**: `validate-xsd` daba por válidos tipos sin resolver, etiquetas desemparejadas y elementos duplicados. `--infer` generaba XSD inválidos con claves JSON no NCName, `--root` con espacios o `--ns` con `&`. Los arrays mixtos usaban solo el primer elemento. BOM, vacío o inexistente daban stack trace. Una raíz array o `{}` daba un XSD vacío con rc=0.
- **Causa Raíz Técnica**: una regex no puede validar la buena formación ni resolver QNames. Un nombre de elemento XML debe ser NCName.
- **Solución Codificada**: `shared/xml-lite.mjs` (`parseXmlLite`, `namespacesInScope`, `findUndeclaredPrefixes`, `isNCName`, `stripBom`). `validate-xsd.mjs` resuelve tipos contra `XSD_BUILTIN_TYPES` y los tipos propios, y detecta duplicados. `toNCName` + `inferXsdWithReport` sanean nombres y devuelven avisos. Se fusionan tipos entre muestras y elementos de arrays, y las entradas inválidas dan error con exit 1.
- **Archivos**: `shared/xml-lite.mjs`, `validate-xsd.mjs`, `sap-cpi-xsd-studio/SKILL.md`.

---

### `LL-024` — Simulador y constructor `.mmap`: escapado, rutas exactas y `--target-xsd`
- **Síntoma**: el simulador producía `&amp;amp;`, resolvía una XPath con descendientes y no validaba la salida con `--target-xsd`. `build-mmap` ignoraba un `--map` mal formado (rc=0, 0 bricks) y una ruta Windows en `--source-xsd` rompía el split por `:`.
- **Solución Codificada**: los valores se extraen ya desescapados y se escapan una sola vez. La XPath se resuelve como ruta absoluta hijo a hijo (`extractValuesFromXml`/`Json`). `validateXmlInstanceAgainstXsd` valida la salida. `splitXsdSpec` respeta `C:\…` y `parseMappingArg` da error (exit 2) ante mapeos inválidos o flags desconocidos.
- **Archivos**: `simulate-mmap.mjs`, `build-mmap.mjs`, `validate-xsd.mjs`.

---

### `LL-025` — Mock suite: XML real, `--strict` y ZIP reproducible
- **Síntoma**: `<a><b>x</a>` pasaba la validación. Un desajuste de correlación daba `valid:true` y rc=0. `customer_id` (JSON) frente a `CustomerId` (XML) no correlacionaba. El ZIP cambiaba en cada ejecución. La SKILL prometía semilla, CSV e IDoc que el script no implementa.
- **Solución Codificada**: buena formación con `parseXmlLite`. Claves canónicas (`canonicalKeyValue`, `extractBusinessKeys`: sin mayúsculas ni `_-.`, atributos y hojas). `--strict` convierte desajustes en errores. Fecha fija (`REPRODUCIBLE_DATE`, `SOURCE_DATE_EPOCH`) salvo `--timestamp`, y nada se escribe si hay errores. La SKILL separa lo que hace el agente de lo que verifica el script.
- **Archivos**: `pack-mock-suite.mjs`, `sap-cpi-mock-data-generator/SKILL.md`, `mcp-server.mjs`.

---

### `LL-026` — XSLT con parser, literales Groovy enmascarados y contrato CLI uniforme
- **Síntoma**: el validador XSLT (solo regex) no detectaba XML mal formado ni prefijos sin declarar, ni construcciones 2.0 en hojas 1.0, y rechazaba comillas simples. El validador Groovy marcaba patrones dentro de literales String. Las flags puestas antes del archivo se tomaban como ruta y un `.zip` corrupto daba stack trace. `--validate-doc` no detectaba secciones vacías. `Bundle-SymbolicName` incluía `; singleton:=true`. 16 CLIs salían con exit 0 sin argumentos.
- **Solución Codificada**: `validate-xslt.mjs` reescrito sobre `parseXmlLite` (motor `--engine 1.0|2.0|3.0`, construcciones 2.0/3.0 con línea, variables sin declarar o duplicadas, llaves en texto respetando CDATA/`xsl:text`/`expand-text`, UTF-16). `stripStringLiterals` en `validate-groovy.mjs` (las reglas estructurales leen el código sin literales). `validateGeneratedDocumentation` comprueba el contenido de cada sección. `parseManifestContent` separa `symbolicName` y `symbolicNameDirectives`. Contrato CLI: sin argumentos o con flag desconocido → exit 2 y uso en stderr.
- **Archivos**: `validate-xslt.mjs`, `validate-groovy.mjs`, `audit-groovy.mjs`, `extract-for-docs.mjs`, `inspect-iflow-zip.mjs`, todos los `scripts/*.mjs`.

### `LL-027` — Limpieza reversible de bundles reales sin romper el iFlow
- **Síntoma**: al compartir exportaciones reales, la redacción `[REDACTED]` solo cubría los `.prop`. Los endpoints, emails, namespaces y valores de parámetros seguían visibles en Groovy, XSD, `.iflw`, `.project` y `MANIFEST.MF`, y un reemplazo simple rompía el bundle al importarlo.
- **Causa Raíz Técnica**: (1) los valores de `parameters.prop` se reutilizan literalmente en otros archivos y en otros bundles del mismo paquete; (2) los valores `Vendor`/`cmdVariantUri` de los adaptadores y las referencias `::` de `.propdef` parecen hosts, pero son metadatos estándar; (3) reescribir `MANIFEST.MF` sin respetar las líneas de 72 bytes lo invalida.
- **Solución Codificada**: `shared/cpi-sanitizer.mjs` y `sanitize-iflow-zip.mjs`. Usan alias sintácticamente válidos y consistentes, un prepaso de `.prop` sobre todos los zips, propagación de valores con límites de palabra y exclusión de metadatos de adaptador. El MANIFEST se transforma por línea lógica y se repliega. Los zips anidados se procesan recursivamente, las entradas ya limpiadas se rechazan y `--restore` se verifica por SHA-256. Se añade la regla `SANITIZED-001` en inspector y packager, y `rules/sap-cpi-privacy-sanitize.md` (preguntar antes de leer).
- **Archivos**: `shared/cpi-sanitizer.mjs`, `sanitize-iflow-zip.mjs`, `inspect-iflow-zip.mjs`, `build-cpi-package.mjs`, `mcp-server.mjs`, `setup-skills.mjs`, `rules/sap-cpi-privacy-sanitize.md`.

### `LL-028` — Documentación técnica PDF con datos de empresa y marca de agua SVG
- **Síntoma**: el PDF de diseño técnico no permitía personalizar la autoría ni aplicar identidad visual; usar `--terms` para ocultar un nombre de producto dejaba alias `SANITIZED_TERM_*` ilegibles en el documento.
- **Causa Raíz Técnica**: el motor PDF solo dibujaba texto. Un SVG de trazados (p. ej. salida de vectorizadores) se puede incrustar como Form XObject reutilizado en todas las páginas, con ExtGState para la opacidad, sin dependencias.
- **Solución Codificada**: `shared/svg-watermark.mjs` (parser M/L/H/V/C/Z + translate, rechaza script/image/href), `watermark` en `createAuditPdfBuffer`, y `--company`/`--watermark` en `extract-for-docs.mjs`. Para documentos legibles, limpiar sin `--terms` salvo que el término sea realmente privado.
- **Archivos**: `shared/svg-watermark.mjs`, `shared/pdf-utils.mjs`, `extract-for-docs.mjs`, `tests/unit/svg-watermark.test.mjs`.

### `LL-029` — PDF técnico con esquema, endpoints, llamadas y ejemplos (modo privacidad)
- **Síntoma**: la documentación PDF solo listaba recuentos y nombres de ficheros; faltaban esquema del flujo, endpoints, llamadas de ejemplo, pasos y parámetros.
- **Causa Raíz Técnica**: el motor PDF solo soportaba secciones, texto y hallazgos, y el generador no interpretaba el BPMN2 del `.iflw`.
- **Solución Codificada**: `shared/iflow-model.mjs` (parser del `.iflw`: procesos, pasos, canales, parámetros, ejemplos de llamada), `shared/pdf-blocks.mjs` (bloques `subsection`, `table`, `code`, `callout`, `diagram` con métricas Helvetica) y `shared/iflow-doc-blocks.mjs` (compone secciones y anexos A/B). Modo privacidad automático para bundles saneados (o `--privacy`): solo alias y `{{Param}}`; nunca se leen valores de `.prop`.
- **Archivos**: `shared/iflow-model.mjs`, `shared/pdf-blocks.mjs`, `shared/iflow-doc-blocks.mjs`, `shared/pdf-utils.mjs`, `extract-for-docs.mjs`, `tests/unit/iflow-doc.test.mjs`.

### `LL-030` — Documento técnico separado del informe de auditoría y esquemas horizontales
- **Síntoma**: el PDF técnico incluía auditoría/puntaje/recomendaciones y los diagramas eran verticales (muchas páginas, nodos poco legibles).
- **Causa Raíz Técnica**: un único generador mezclaba dos documentos con audiencias distintas; `diagram` apilaba los pasos en una columna.
- **Solución Codificada**: las secciones 6–8 solo se emiten con `--include-audit`. `renderDiagram` dispone el flujo en tramos horizontales (6 capas por banda) con conectores circulares A/B/C entre tramos, nodos con acento de color, eventos en cápsula, gateways en rombo y sistemas externos arriba/abajo.
- **Archivos**: `shared/pdf-blocks.mjs`, `extract-for-docs.mjs`, `tests/unit/iflow-doc.test.mjs`, `docs/CLI_REFERENCE.md`.

### `LL-031` — Documento técnico estilo especificación y nodos compactos
- **Síntoma**: el PDF técnico era pobre (listados de ficheros, bytes de ficheros de configuración) y los nodos del esquema ocupaban demasiado, partiendo el diagrama en muchos tramos.
- **Causa Raíz Técnica**: el generador mostraba metadatos del paquete en lugar de documentar diseño, interfaces y operación; los nodos llevaban el texto dentro de una caja grande.
- **Solución Codificada**: `shared/iflow-doc-sections.mjs` compone 10 secciones (objetivo y alcance con ficha técnica, arquitectura, flujo funcional con rutas de decisión, interfaces y ejemplos, configuración, scripts, errores, seguridad, operación con resolución de incidencias, glosario) más control de versiones. No se menciona ningún fichero de configuración ni su tamaño. Nodos de 40x24 con la etiqueta debajo y 9 columnas por tramo.
- **Archivos**: `shared/iflow-doc-sections.mjs`, `shared/iflow-doc-blocks.mjs`, `shared/pdf-blocks.mjs`, `extract-for-docs.mjs`, `tests/unit/iflow-doc.test.mjs`.

### `LL-032` — Pasos con información funcional y procesos como secuencia numerada
- **Síntoma**: la tabla de pasos del documento técnico copiaba la configuración del iFlow (nombre, tipo, valores) sin aportar nada; los procesos de error se imprimían como una línea `A -> B -> C` ilegible y el nombre de subproceso solapaba la columna siguiente.
- **Causa Raíz Técnica**: el generador no interpretaba el rol de cada paso en el ciclo ni documentaba el porqué de la arquitectura.
- **Solución Codificada**: `shared/iflow-functional.mjs` deriva por paso "Qué aporta al ciclo / Consume / Produce" (con análisis de E/S de los Groovy: propiedades y cabeceras leídas/escritas). Los procesos de error se muestran en tabla con pasos numerados.
- **Archivos**: `shared/iflow-functional.mjs`, `shared/iflow-doc-sections.mjs`, `shared/iflow-doc-blocks.mjs`, `tests/unit/iflow-doc.test.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-033` — Índice con enlaces, espaciado jerárquico y pie con marca de empresa
- **Síntoma**: el índice era una lista plana sin páginas ni enlaces, el espaciado entre bloques era uniforme (títulos pegados al contenido anterior) y la marca de agua restaba legibilidad.
- **Causa Raíz Técnica**: el motor PDF no conocía la jerarquía del documento ni en qué página caía cada título.
- **Solución Codificada**: `createAuditPdfBuffer` maqueta en dos pasadas; el bloque `toc` lista secciones y subsecciones (nivel por numeración) con puntos guía, número de página y anotaciones `/Link` con `/Dest` interno. Tabla de separaciones por tipo de bloque (sección 26 > subsección 12 > tabla/llamada 8 > párrafo 4) y menor tras un título; los títulos reservan espacio para no quedar huérfanos; bloque `pagebreak`. La marca de agua desaparece: `docSpec.brand = { svg }` dibuja el logo en el pie junto al nombre de la empresa y "Página N de M". CLI: `--logo` sustituye a `--watermark`.
- **Archivos**: `shared/pdf-utils.mjs`, `shared/pdf-blocks.mjs`, `shared/iflow-doc-sections.mjs`, `extract-for-docs.mjs`, `tests/lessons/lessons.test.mjs`, `tests/unit/svg-watermark.test.mjs`.

### `LL-034` — Sin decisiones de diseño inventadas y documentación de mapeos
- **Síntoma**: el documento incluía "decisiones de diseño" con su motivo, deducidas de la forma del flujo pero no conocidas realmente; y los mapeos (.mmap, XSLT, XSD) no aparecían.
- **Causa Raíz Técnica**: el generador especulaba sobre intenciones que el paquete no contiene y no tenía un módulo que describiera los recursos de transformación.
- **Solución Codificada**: se elimina `designDecisions` (solo se documenta lo observable). `shared/iflow-mappings.mjs` genera en la sección 6 los pasos de mapeo del iFlow, los campos destino/origen de cada .mmap, las expresiones de cada XSLT, los elementos raíz de cada XSD, y avisa si un recurso referenciado no está en el paquete. Los pasos Mapping/XSLTMapping indican el recurso en la sección 3.
- **Archivos**: `shared/iflow-mappings.mjs`, `shared/iflow-functional.mjs`, `shared/iflow-doc-sections.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-035` — Descripción funcional de pasos Data Store
- **Síntoma**: los pasos Data Store (get/put/delete) aparecían como "Paso de proceso" sin explicar su función.
- **Causa Raíz Técnica**: `functionalStep` no contemplaba la actividad `DBstorage`.
- **Solución Codificada**: describe la operación (recupera, guarda, elimina) y sus opciones (borrado tras lectura, fallo si no existe, cabeceras, caducidad). El nombre del Data Store solo se cita si es un parámetro `{{Param}}`, nunca un literal.
- **Archivos**: `shared/iflow-functional.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-036` — Pie de página del PDF descentrado
- **Síntoma**: en el pie, el logo y el nombre de la empresa quedaban a distinta altura y pegados al margen izquierdo, no centrados.
- **Causa Raíz Técnica**: el logo se centraba verticalmente sobre una línea y el texto usaba una línea base distinta, y ambos arrancaban en el margen izquierdo.
- **Solución Codificada**: `createAuditPdfBuffer` calcula una línea central común, mide el grupo logo+texto de marca y lo centra horizontalmente en la página; "Página N de M" queda alineado a la derecha en la misma línea base.
- **Archivos**: `shared/pdf-utils.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-037` — Salida Word editable (.docx)
- **Síntoma**: el documento técnico solo existía en PDF y no se podía editar.
- **Causa Raíz Técnica**: el motor de documento solo tenía un renderizador (PDF); el .doc binario no es viable sin dependencias.
- **Solución Codificada**: `shared/docx-writer.mjs` genera Office Open XML (.docx) desde el mismo docSpec: estilos Heading reales, índice como campo TOC, tablas nativas, listas, llamadas, diagramas como formas de Word agrupadas y pie con logo + campos PAGE/NUMPAGES. CLI `--docx <salida.docx>` y parámetro MCP `docxPath`. Word puede abrirlo y guardarlo como .doc si se necesita ese formato.
- **Archivos**: `shared/docx-writer.mjs`, `skills/sap-cpi-architect/scripts/extract-for-docs.mjs`, `mcp-server.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-038` — JSON/XML mostrados como texto plano en el documento
- **Síntoma**: los ejemplos de solicitud/respuesta (JSON, XML, HTTP) aparecían en el PDF y el Word como líneas de texto sin formato ni indentación.
- **Causa Raíz Técnica**: el bloque `code` se pintaba como texto monoespaciado sin detectar el lenguaje ni reindentar.
- **Solución Codificada**: `shared/code-format.mjs` detecta JSON/XML/HTTP (o usa `language`), reindenta JSON y XML válidos y tokeniza cada línea con colores (claves, cadenas, números, etiquetas, atributos). Lo usan `pdf-blocks.mjs` y `docx-writer.mjs`. Los cuerpos que no se pueden deducir del paquete no se inventan.
- **Archivos**: `shared/code-format.mjs`, `shared/pdf-blocks.mjs`, `shared/docx-writer.mjs`, `shared/iflow-doc-blocks.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-039` — Salida Word también para auditoría y comparación
- **Síntoma**: solo el documento técnico se podía exportar a Word; los informes de auditoría, post-remediación y comparación solo salían en PDF.
- **Causa Raíz Técnica**: `--docx` / `docxPath` solo estaba cableado en `extract-for-docs` y `cpi_export_technical_doc`.
- **Solución Codificada**: `inspect-iflow-zip.mjs` y `diff-iflow-zip.mjs` aceptan `--docx <ruta>`; `cpi_inspect_zip`, `cpi_remediate_zip` y `cpi_diff_bundles` aceptan `docxPath`. Reutilizan el mismo docSpec que el PDF.
- **Archivos**: `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`, `skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs`, `mcp-server.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-040` — Ejemplos en texto negro y diagrama con un único nodo
- **Síntoma**: los ejemplos de código salían coloreados (se pidió texto negro) y, en el Word, un proceso con un único elemento suelto se dibujaba como una caja gigante a todo el ancho.
- **Causa Raíz Técnica**: el coloreado de sintaxis se aplicaba por fragmento; y el grupo DrawingML se ajustaba al contenido, estirando la única forma hasta ocupar todo el grupo.
- **Solución Codificada**: PDF y Word imprimen el código con `CODE_TEXT` (negro) conservando la reindentación de JSON/XML. `groupDrawing` añade un marco invisible del tamaño del grupo, por lo que un nodo solo mantiene su tamaño normal.
- **Archivos**: `shared/code-format.mjs`, `shared/pdf-blocks.mjs`, `shared/docx-writer.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-041` — Datos del documento reducidos a lo necesario
- **Síntoma**: la sección "Datos del Documento" incluía razón social, identificación fiscal, proyecto, cliente, versión del documento, clasificación y contacto, que no hacían falta y aumentaban el riesgo de volcar datos de identidad en el documento.
- **Causa Raíz Técnica**: `COMPANY_FIELDS` admitía y mostraba campos de identificación que el documento técnico no necesita.
- **Solución Codificada**: `loadCompanyInfo` solo admite `name`, `address`, `author`, `reviewer` y `date`; el pie usa solo el nombre de la empresa. Los demás campos del JSON de empresa se ignoran.
- **Archivos**: `skills/sap-cpi-architect/scripts/extract-for-docs.mjs`, `mcp-server.mjs`, `docs/CLI_REFERENCE.md`, `skills/sap-cpi-architect/SKILL.md`, `tests/lessons/lessons.test.mjs`.

### `LL-042` — Informe de auditoría por categorías y con tablas
- **Síntoma**: el informe de auditoría era una lista larga de hallazgos sin agrupar, difícil de leer.
- **Causa Raíz Técnica**: `buildAuditPdfSpec` volcaba cada hallazgo como bloque suelto, sin índice, resumen ni categorías.
- **Solución Codificada**: `collectAuditFindings` clasifica los hallazgos en Seguridad, Fiabilidad, Rendimiento, Código Groovy y Paquete, ordenados por severidad. El informe lleva índice, resumen ejecutivo, inventario, matriz categoría × severidad, una tabla por categoría (severidad, componente, hallazgo, recomendación) y tabla de correcciones automatizables. Si el bundle es una copia saneada, un aviso explica por qué la nota está penalizada. Sirve igual para PDF y Word.
- **Archivos**: `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-043` — Informes de auditoría sin nota
- **Síntoma**: la nota 0-100 del informe de auditoría no aporta valor y confunde (una copia limpiada siempre salía con 0/100).
- **Causa Raíz Técnica**: `buildAuditPdfSpec` y la salida de consola mostraban la puntuación (kv, insignia SCORE del PDF, columna «Nota» de paquetes anidados).
- **Solución Codificada**: el PDF/Word de auditoría y la consola ya no muestran puntuación; el informe se centra en los hallazgos por categoría. `heuristics.score` se conserva solo en `--json` por compatibilidad.
- **Archivos**: `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-044` — Pruebas de cierre: carpetas de salida, hallazgos Groovy y paquetes anidados
- **Síntoma**: al pedir `--pdf`/`--docx` (o `pdfPath`/`docxPath` por MCP) en una carpeta que no existe, el comando fallaba con `ENOENT`; los hallazgos Groovy del informe mostraban `[undefined]`; el informe de un Multi-Bundle incluía un inventario con ceros; el subtítulo del PDF se truncaba y el documento técnico con `--include-audit` mostraba una insignia SCORE.
- **Causa Raíz Técnica**: los escritores compartidos no creaban el directorio padre; el informe leía `gf.code` en lugar de `gf.ruleId`; el inventario se calculaba también para paquetes anidados; el subtítulo era demasiado largo para la cabecera.
- **Solución Codificada**: `writePdfFile`/`writeDocxFile` crean las carpetas (`mkdirSync recursive`); el informe usa `ruleId`, omite el inventario en Multi-Bundle y usa un subtítulo corto; se elimina la insignia SCORE del documento técnico; el hallazgo de copia del body muestra solo el nombre de la propiedad (no el XML escapado) y el del manifiesto no repite el prefijo de severidad.
- **Archivos**: `shared/pdf-utils.mjs`, `shared/docx-writer.mjs`, `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`, `skills/sap-cpi-architect/scripts/extract-for-docs.mjs`, `mcp-server.mjs`, `tests/lessons/lessons.test.mjs`.

### `LL-045` — Perfil de marca compartido para todos los documentos
- **Síntoma**: el logo y los datos de empresa solo se aplicaban al documento técnico y había que pasar `--company`/`--logo` en cada ejecución; auditoría y diff salían sin marca.
- **Causa Raíz Técnica**: la marca vivía como opciones del generador del documento técnico, no como configuración compartida por los escritores PDF/Word.
- **Solución Codificada**: `shared/brand.mjs` (`loadBrandProfile`, `withBrand`, `saveBrandProfile`) lee `.cpi-brand/{company.json,logo.svg}`; `writeAuditPdfFile` y `writeDocxFile` lo aplican a cualquier docSpec sin marca propia; `brand-setup.mjs` lo crea/consulta/borra; `--no-brand` lo desactiva. El agente pregunta una sola vez si no hay perfil (SKILL.md/AGENTS.md). `.cpi-brand/` está en `.gitignore`.
- **Archivos**: `shared/brand.mjs`, `shared/pdf-utils.mjs`, `shared/docx-writer.mjs`, `skills/sap-cpi-architect/scripts/brand-setup.mjs`, `skills/sap-cpi-architect/scripts/extract-for-docs.mjs`, `.gitignore`, `tests/lessons/lessons.test.mjs`.

### `LL-046` — Sin nota en documento técnico, diff ni auditor Groovy
- **Síntoma**: la sección 7 «Puntaje de Cumplimiento» del documento técnico, la evolución de Score del informe de diff y el «Score de Calidad» del auditor Groovy mostraban una nota numérica que no aporta valor (mismo motivo que LL-043).
- **Causa Raíz Técnica**: la nota se pintaba en el Markdown de 8 secciones, en el PDF técnico con `--include-audit`, en el kv/subtítulo/consola del diff y en la salida de texto de `audit-groovy.mjs`.
- **Solución Codificada**: el contrato del Markdown pasa a **7 secciones** (la antigua 8 «Recomendaciones de Modernización» es ahora la 7; `doc-template-8-sections.md` → `doc-template-7-sections.md`); el diff y el auditor Groovy muestran cambios y número de hallazgos en lugar de puntuación. `score`/`scoreDelta` se conservan solo en `--json` por compatibilidad.
- **Archivos**: `skills/sap-cpi-architect/scripts/extract-for-docs.mjs`, `skills/sap-cpi-architect/references/doc-template-7-sections.md`, `skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs`, `skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs`, `SKILL.md` afectadas, `docs/CLI_REFERENCE.md`, `tests/lessons/lessons.test.mjs`.

### `LL-047` — Participante receptor con la errata `EndpointRecevier` no se clasificaba
- **Síntoma**: en un `.iflw` cuyo participante receptor tiene `ifl:type="EndpointRecevier"` pero un `name`/`id` sin la palabra «Receiver», el canal de salida no se detectaba como outbound y quedaba fuera del cliente API/endpoints.
- **Causa Raíz Técnica**: SAP escribe el tipo con la errata «Recevier»; la expresión `/Receiv?er/` solo admite «Receiver» y «Receier», nunca «Recevier».
- **Solución Codificada**: `parseParticipants` y `classifyMessageFlow` usan `/Rece(?:iv|vi)er/i`, que admite ambas grafías.
- **Archivos**: `skills/sap-cpi-architect/scripts/export-api-client.mjs`.

### `LL-048` — La remediación `groovy` anunciada por el inspector era rechazada
- **Síntoma**: `availableRemediations` ofrecía el id `groovy`, pero `--remediate groovy` (o `cpi_remediate_zip`) fallaba con «Remediación desconocida: groovy».
- **Causa Raíz Técnica**: la corrección existía en `remediateBundleZip`, pero `REMEDIATION_IDS` (lista de validación) no la incluía y la ayuda/SKILL tampoco.
- **Solución Codificada**: `REMEDIATION_IDS` incluye `groovy`; ayuda de la CLI y `SKILL.md` actualizadas. La corrección solo reescribe variables cuyo nombre termina en `reader` (`reader.getText("UTF-8")`) y `JsonSlurper`→`JsonSlurperClassic`.
- **Archivos**: `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`, `skills/sap-cpi-zip-inspector/SKILL.md`.

### `LL-049` — El Word técnico mostraba «Contenido» dos veces y lo metía en el índice
- **Síntoma**: en el `.docx` del documento técnico aparecía el título «Contenido» duplicado (un Heading1 y el título del índice), y al actualizar el índice en Word el propio «Contenido» se listaba como entrada.
- **Causa Raíz Técnica**: `iflow-doc-sections.mjs` emite una sección «Contenido» antes del bloque `toc`, y `docx-writer.mjs` ya pinta su propio `TocHeading` (fuera del esquema); el Heading1 sí entra en el campo `TOC \o "1-3"`.
- **Solución Codificada**: el escritor Word omite la sección «Contenido» cuando el bloque siguiente es `toc`.
- **Archivos**: `shared/docx-writer.mjs`.
