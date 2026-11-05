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
