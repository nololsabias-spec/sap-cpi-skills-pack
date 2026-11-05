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
- **Causa Raíz Técnica**: El runtime de SAP CPI utiliza **Groovy 2.4**, donde `XmlSlurper` y `XmlParser` pertenecen al paquete **`groovy.util.XmlSlurper`** y **`groovy.util.XmlParser`** (en Groovy 3+ se movieron a `groovy.xml.*`, pero en CPI Groovy 2.4 ese import no existe o causa conflicto de resolución).
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
  5. **Constructor de Paquetes OSGi de Value Mapping (`build-value-mapping.mjs` / MCP `cpi_build_value_mapping`)**: Construye archivos `.zip` de Value Mapping 100% compatibles con SAP Integration Suite a partir de esquemas JSON o tablas CSV, configurando `.project` con la naturaleza `com.sap.ide.ifl.nature.valuemapping`, `META-INF/MANIFEST.MF` plegado a 72 bytes con `SAP-BundleType: ValueMapping`, `metainfo.prop` y `value_mapping.xml`.

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
  1. **Soporte de Exchange Properties y Headers en `test-camel-regex.mjs`**: Se incorporaron los argumentos CLI `--prop`, `--property` y `--header` (con soporte para sintaxis `flag valor` y `flag=valor`), generando automáticamente expresiones Apache Camel Simple normalizadas (`${property.VariableName}` y `${header.VariableName}`) además de `--field`.
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





