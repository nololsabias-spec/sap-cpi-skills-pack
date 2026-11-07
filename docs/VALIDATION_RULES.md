# Especificación de Reglas de Validación Determinista (`VALIDATION_RULES.md`)

Este documento detalla todas las reglas técnicas verificadas por los scripts de `sap-cpi-skills-pack`.

---

## 1. Reglas de Auditoría de Arquitectura BPMN 2.0 (`.iflw`)

Aplicadas por `inspect-iflow-zip.mjs` y `build-cpi-package.mjs`:

| Código | Severidad | Regla | Descripción Técnica |
| :--- | :--- | :--- | :--- |
| `IFLW-001` | `HIGH` | **Exception Subprocess Obligatorio** | Todo proceso de integración debe incluir un `<bpmn2:subProcess>` con la propiedad `activityType = ErrorEventSubProcessTemplate` para capturar fallos de ejecución. |
| `IFLW-002` | `CRITICAL` | **Prohibición de HTTP sin cifrado TLS** | Detecta adaptadores o endpoints configurados con `http://` plano (excluyendo namespaces estándar XML/W3C). Exige `https://`. |
| `IFLW-003` | `MEDIUM` | **Externalización de Parámetros (`{{param}}`)** | Detecta URLs fijas o credenciales incrustadas en propiedades `<ifl:property>` en lugar de parámetros externalizados `{{Host_Endpoint}}`. |
| `IFLW-004` | `MEDIUM` | **Timeouts Explícitos en `ExternalCall`** | Verifica que todo paso `Request-Reply` (`ExternalCall`) tenga un timeout en el `messageFlow` (canal) asociado. La autorremediación (`--fix timeouts`) solo añade `httpRequestTimeout` en `bpmn2:messageFlow/extensionElements` cuando `ComponentType=HTTP`, nunca en el `serviceTask`. Otros adaptadores (OData, SOAP…) usan claves propias y se reportan para revisión manual. Es idempotente. |
| `IFLW-005` | `HIGH` | **Prevención de Fuga de Memoria en Content Modifier** | Bloquea el almacenamiento de `${body}` o `${in.body}` dentro de Exchange Properties o Headers en pasos `Enricher` (Content Modifier), ya que las propiedades persisten durante toda la vida del Exchange. |
| `IFLW-006` | `ADVISORY` | **Streaming en Splitters (`streaming=true`)** | Detecta pasos `Splitter` (`General`/`Iterating Splitter`) con `<key>streaming</key><value>false</value>`, recomendando activar streaming para evitar cargar lotes XML/JSON completos en memoria DOM. |
| `IFLW-007` | `ADVISORY` | **Ruta por Defecto en Routers (`default`)** | Verifica que todo `<bpmn2:exclusiveGateway>` defina su atributo `default` para evitar fallos por mensajes sin ruta coincidente. |
| `IFLW-008` | `ADVISORY` | **CPILint `CleartextBasicAuth` y `CsrfProtectionRequired`** | Detecta Basic Auth **por canal** (`messageFlow`) con la clave propia de cada adaptador: HTTP/OData `authenticationMethod=Basic`, SOAP/IDoc `authentication=Basic`, XI `AuthenticationType=BasicAuthentication`, AS2 `authenticationType=BasicAuthentication` y AS4 `authenticationType=basic`. Queda exento si el canal declara `proxyType=sapcc` (Cloud Connector on-premise). También detecta `xsrfProtection=0` (CSRF deshabilitado). |
| `OSGI-001` | `CRITICAL` | **Raíz OSGi sin Carpeta Intermedia (`manifestIssues`)** | Verifica que `META-INF/MANIFEST.MF` esté exactamente en la raíz del `.zip` (`META-INF/MANIFEST.MF` y no `Subcarpeta/META-INF/MANIFEST.MF`). Evita el error `Upload the artifact failed. The project must contain a valid manifest file`. |
| `OSGI-002` | `CRITICAL` | **Límite de 72 Bytes UTF-8 por Línea en `MANIFEST.MF`** | Verifica que ninguna línea física de `META-INF/MANIFEST.MF` supere los 72 bytes UTF-8 y que las continuaciones inicien con espacio simple (`\r\n `). La reparación y el clonado despliegan (unfold) las cabeceras antes de modificarlas y conservan las secciones `Name:` separadas por línea en blanco (`shared/manifest-utils.mjs`). |
| `ZIP-001` | `CRITICAL` | **Zip-Slip y Rutas Inseguras** | Se rechaza cualquier entrada con ruta absoluta, letra de unidad, `..` o bytes nulos, tanto al leer como al crear o extraer `.zip` (`resolveInside`). |
| `ZIP-002` | `CRITICAL` | **Límites Anti Zip-Bomb** | Máx. 5000 entradas, 64 MB por entrada, 256 MB en total y ratio de compresión ≤ 200 (en entradas > 1 MB). Ajustable con `readZipEntries(input, { limits })`. |
| `PRIV-001` | `CRITICAL` | **Redacción de `.prop`** | Los valores de `parameters.prop` (y de cualquier `.prop` salvo `metainfo.prop`) se devuelven como `[REDACTED]` en `extractBundleFile` y `diff-iflow-zip`, y como `{{key}}` en Postman/OpenAPI. Solo se muestran con opt-in explícito (`showPropValues` / `--resolve-params`). |

---

## 2. Reglas de Validación y Scoring para Scripts Groovy

Aplicadas por `validate-groovy.mjs` y `audit-groovy.mjs`.

### 2.1. Fórmula de Puntuación (Score 0 - 100)
Todo script parte de **100 puntos** y se restan puntos según la severidad de cada hallazgo:
- **CRÍTICA (`CRITICAL`):** `-30` puntos
- **ALTA (`HIGH`):** `-15` puntos
- **MEDIA (`MEDIUM`):** `-5` puntos
- **BAJA (`LOW`):** `-2` puntos

### 2.2. Reglas Base y *Ensure Upgrade Readiness* (Groovy 2.4 / Groovy 4)
1. **Firma Oficial (Script v1 y v2):** Debe declarar `import com.sap.gateway.ip.core.customdev.util.Message` (v1) o `import com.sap.it.script.v2.api.Message` (v2 / Groovy 4) y `def Message processData(Message message)` retornando `message`.
2. **Prohibición de Wildcards (`UPGRADE-WILDCARD`):** Prohibido usar `import paquete.*`. Toda clase debe importarse explícitamente para superar el chequeo *Ensure Upgrade Readiness* de SAP CPI.
3. **Cero Imports No Utilizados (`UPGRADE-UNUSED-IMPORT`):** Todo `import` declarado debe referenciarse en el cuerpo del script.
4. **Prohibición de Frameworks Restringidos e Internos (`INTERNAL_CAMEL_IMPORT`):** Según la directriz oficial SAP *"Restrict usage to supported frameworks and libraries"*, está prohibido importar `org.apache.camel.impl.*`, `org.apache.camel.processor.*`, `com.sap.it.script.v2.api.proxy.*`, `org.osgi.framework.*`, `org.springframework.*`, `com.zaxxer.hikari.*`, `groovy.sql.*`, `org.quartz.*` o `net.sf.saxon.*`.
5. **Compatibilidad de Paquete XML en Groovy 2.4 vs Groovy 4 (versión explícita con `--groovy 2.4|4` / `groovyVersion`):** La versión de Groovy se elige en el paso Script del iFlow y **no se infiere** de la API `Message` (v1/v2).
   - `GROOVY24_INVALID_XMLSLURPER_IMPORT` (`CRITICAL`, solo con `--groovy 2.4`): `groovy.xml.XmlSlurper`, `XmlParser` y `slurpersupport.GPathResult` no existen en Groovy 2.4. Usa `groovy.util.*`.
   - `GROOVY4_REMOVED_GROOVY_UTIL_XML` (`CRITICAL`, solo con `--groovy 4`): `groovy.util.XmlSlurper`, `XmlParser`, `XmlNodePrinter` y `slurpersupport.GPathResult` se eliminaron en Groovy 4. Usa `groovy.xml.*`.
   - `GROOVY_VERSION_DEPENDENT_XML_API` (`MEDIUM`, sin versión): el script usa una API XML que solo compila en una de las dos versiones; indica `--groovy` para validarlo con certeza.
   - `GROOVY4_CAMEL_IMPORT` (`HIGH`, solo con `--groovy 4`): import directo de `org.apache.camel.*`.
   - `GROOVY4_DATE_EXTENSIONS` (`MEDIUM`, solo con `--groovy 4`): `Date.format()` / `Date.parse()` de la GDK, que en Groovy 4 dependen del módulo opcional `groovy-dateutil`. Usa `java.time`.
6. **Prohibición de `Reader.getText(String charset)` (`READER_GETTEXT_CHARSET_ERROR`):** En Java y Groovy, `Reader` (`BufferedReader`, `StringReader`) ya es un flujo de caracteres y carece de método `.getText(String charset)`. Llamar a `bodyReader.getText('UTF-8')` lanza `MissingMethodException: No signature of method: java.io.BufferedReader.getText() is applicable for argument types: (java.lang.String) values: [UTF-8]`. Debe pasarse el `Reader` directamente a `.parse(bodyReader)` o llamarse `bodyReader.getText()` **sin argumentos**.
7. **Prevención de Fuga en Metaspace (`DYNAMIC_CODE_EVAL_OOM`):** Prohibido instanciar `GroovyShell` o `Eval.me()` en tiempo de ejecución, ya que genera ClassLoaders por cada mensaje hasta agotar la memoria Metaspace del Worker Node.
5. **Prohibición de `setBody` con 2 argumentos (`API-SETBODY-ARGS`):** `message.setBody(payload, Class)` no existe en la interfaz `Message` de SAP CPI; debe usarse únicamente `message.setBody(payload)`.
6. **Seguridad XML Anti-XXE (`SEC-XXE`):** Todo uso de `XmlSlurper` o `XmlParser` debe deshabilitar DTDs externos mediante `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`. El analizador de comentarios preserva literales URL (`http://`, `https://`) para evitar falsos positivos al verificar features SAX/DOM.
8. **Inmutabilidad y Seguridad de Hilos en `@Field` y `Binding` (`MUTABLE_FIELD_STATE` / `UNDECLARED_BINDING_VARIABLE`):** Si se emplea `@Field` (`groovy.transform.Field`) para constantes a nivel de script, debe declararse obligatoriamente con `final` (`@Field final`). Asimismo, toda variable dentro de `processData` debe declararse con `def` o tipo explícito (`String`, `Map`, etc.); asignar variables sin declararlas las inyecta en el `Binding` global compartido de la instancia `Script`, provocando condiciones de carrera entre hilos concurrentes.
9. **Gestión de Zona Horaria (`TZ-DEFAULT`):** Prohibido usar `new Date()` o `LocalDateTime.now()` sin `ZoneId.of("UTC")` explícito.
10. **Higiene del Message Processing Log (`MPL-UNCONDITIONAL`):** Todo `addAttachmentAsString` debe ejecutarse únicamente dentro de bloques `catch`, en scripts manejadores de `CamelExceptionCaught` / `SAP_MessageProcessingLogCustomStatus` o condicionado a `LogAttachments` / `ENABLE_PAYLOAD_LOGGING` / `SAP_MessageProcessingLogLevel` (`DEBUG` / `TRACE`).
11. **Protección de Cabeceras Reservadas (`RESERVED_HEADER_MUTATION`):** Bloquea la sobrescritura de cabeceras internas de Apache Camel (`Camel*`) y de sistema (`SAP_*`), permitiendo explícitamente las cabeceras oficiales de monitoreo MPL de SAP CPI (`SAP_ApplicationID`, `SAP_Sender`, `SAP_Receiver`, `SAP_MessageType`, `SAP_MplCorrelationId`, `SAP_PregeneratedMplId`).

### 2.3. Reglas por Directiva Activa (`--directives`)
- `jsonSlurper`: Exige `groovy.json.JsonSlurperClassic` en lugar de `JsonSlurper` (`LazyMap` no serializable en CPI).
- `streaming`: Exige `message.getBody(java.io.Reader)` y cierre explícito en bloque `finally`.
- `xmlParser`: Distingue lectura (`XmlSlurper` + `StreamingMarkupBuilder`) de mutación in-place (`XmlParser` + `XmlNodePrinter`).
- `mpl`: Verifica adjuntos MPL protegidos por nivel de log o bloque de excepción.
- `secureStore`: Exige `ITApiFactory.getService(SecureStoreService.class, null)` y validación de nulidad de `getUserCredential`.
- `valueMapping`: Exige `ITApiFactory.getApi(ValueMappingApi.class, null)`.
- `utcDates`: Exige `java.time.*` con `ZoneId.of("UTC")`.
- `headers`: Exige acceso tipado/seguro con `?.toString()` y valores por defecto.
- `sql`: Prohibida la interpolación GString `"SELECT ... ${var}"`; exige parámetros `?`.
- `throwEx`: Exige bloques `try / catch (Exception e)` relanzando `throw new Exception("CPI-ERR: ...")`.

---

## 3. Reglas de Validación XSLT (`validate-xslt.mjs`)

1. **Bloqueo de Sintaxis Híbrida Inválida (`XSLT-CURLY-TEXT`):** En XSLT, las llaves `{campo}` (Attribute Value Templates) solo se evalúan dentro de atributos XML. Escribir `<Tag>{campo}</Tag>` imprime literalmente `{campo}`; debe usarse `<xsl:value-of select="campo"/>`.
2. **Compatibilidad de Motor XSLT 1.0 (Xalan):**
   - Prohibido usar `exclude-result-prefixes="#all"` (exclusivo de XSLT 2.0).
   - Prohibido usar `<xsl:for-each-group>` en XSLT 1.0 (requiere Muenchian Grouping con `<xsl:key>` y `generate-id()`).
3. **Limpieza de Nodos en Blanco:** Verifica la presencia de `<xsl:strip-space elements="*"/>`.
4. **Funciones de Extensión SAP CPI (`--scenario=headers`):** Exige declarar `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` o `xmlns:sapci="http://sap.com/it/"`, `exclude-result-prefixes` y `<xsl:param name="exchange"/>`. Para lecturas de cabeceras/propiedades entrantes se recomienda la inyección directa mediante `<xsl:param name="HeaderName" select="'DEFAULT'"/>`.
5. **XSLT 3.0 `json-to-xml()` (Saxon-HE):** Verifica que si se utiliza `json-to-xml()`, el atributo `version="3.0"` esté declarado junto con `xpath-default-namespace="http://www.w3.org/2005/xpath-functions"`.

---

## 4. Reglas de Expresiones Regulares y Apache Camel (`test-camel-regex.mjs`)

1. **Anclaje Estricto:** Toda expresión regular de validación debe iniciar con `^` y finalizar con `$` para evitar coincidencias parciales accidentales en el Router de SAP CPI.
2. **Prevención de ReDoS (*Catastrophic Backtracking*):** Detecta cuantificadores anidados ambiguos como `(.+)+`, `(.*)+` o `([a-zA-Z]+)*` que pueden bloquear los hilos de trabajo del tenant SAP CPI.
3. **Listas de Inclusión/Exclusión (`not in`) y Fechas con Zona Horaria:** Uso de alternancia anclada `^(US|CA|MX)$` con `regex` / `not regex` y expresiones `${date-with-timezone:now:UTC:yyyy-MM-dd'T'HH:mm:ss'Z'}`.

---

## 5. Reglas de Esquemas W3C XSD 1.0 (`validate-xsd.mjs`) y Mapeos Gráficos `.mmap` (`build-mmap.mjs`)

1. **Prohibición de `<xsd:all>`:** El motor gráfico de Message Mapping de SAP CPI presenta limitaciones severas con `<xsd:all>`; todos los elementos hijos complejos deben modelarse con `<xsd:sequence>`.
2. **Prevención de *Namespace Prefix Conflict*:** Cuando el esquema define `targetNamespace`, exige declarar también el prefijo propio (`xmlns:tns="..."`) junto con `elementFormDefault="qualified"`.
3. **Compatibilidad `nillable="true"` + `minOccurs="0"` (SAP Note 2624922):** Advierte cuando un elemento declara `nillable="true"` sin `minOccurs="0"`, ya que el *JSON to XML Converter* de SAP CPI puede omitir etiquetas nulas en lugar de emitir `xsi:nil="true"`.
4. **Límite de Nodos:** Verifica que el esquema no supere los `20.000` nodos XML para evitar bloqueos de memoria en el editor de mapeos.
5. **Estructura `<xiObj>` y Contenedores Padre en `.mmap` (`build-mmap.mjs`):** Verifica que todo archivo `.mmap` declare `<xiObj xmlns="urn:sap-com:xi">`, vincule los esquemas origen y destino en `src/main/resources/xsd` (`SOURCE_IFR_MESS` y `TARGET_IFR_MESS`), declare `<tr:XiTrafo xmlns:tr="urn:sap-com:xi:mapping:xitrafo">` e instancie un `<brick type="Dst">` contenedor (`Constant`) para cada nodo padre intermedio en rutas destino anidadas (`/Root/Padre/Hijo`).

---

## 6. Reglas de Empaquetado OSGi (`build-cpi-package.mjs` y `clone-iflow-bundle.mjs`)

Para que un paquete iFlow + Script Collection sea importable sin errores en SAP Integration Suite (`Upload the artifact failed. The project must contain a valid manifest file`):
- **Estructura en Raíz del ZIP (`stripRootFolderPrefix`)**: `.project`, `metainfo.prop`, `META-INF/MANIFEST.MF` y `src/main/resources/...` deben residir directamente en la raíz del archivo `.zip`, sin ninguna carpeta contenedora intermedia, y ordenados con `.project` y `META-INF/MANIFEST.MF` al inicio del archivo.
- **Plegado a 72 Bytes UTF-8 (`wrapManifestLine72`)**: Las líneas de `META-INF/MANIFEST.MF` nunca deben superar los **72 bytes UTF-8**; las continuaciones deben dividirse con `\r\n ` (CRLF + espacio inicial) y finalizar con línea en blanco (`\r\n\r\n`).
- El `MANIFEST.MF` del **Script Collection** debe declarar `Provide-Capability: scriptcollection.<SC_ID>;version:Version="1.0.0"`.
- El `MANIFEST.MF` del **Integration Flow** debe declarar `Require-Capability: scriptcollection.<SC_ID>;filter:="(&(version>=1.0.0))"` (o `resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`) y `SAP-BundleType: IntegrationFlow`.
- En el archivo `.iflw`, todo paso de script que invoque una Script Collection debe incluir `<ifl:property><key>scriptBundleId</key><value><SC_ID></value></ifl:property>`.
- **Subida Individual**: Cada `.zip` (`<ScriptCollection>.zip` y `<Iflow>.zip`) debe importarse individualmente en SAP CPI, nunca subiendo un `.zip` contenedor que agrupe varios archivos `.zip`.

---

## 7. Reglas de Exportación de Clientes de Prueba API (Postman & OpenAPI)

Aplicadas por `export-api-client.mjs`:
1. **Handshake CSRF Automático (`pm.sendRequest` en `prerequest`)**: Toda petición POST protegida por CSRF debe incluir un script `prerequest` que solicite automáticamente `x-csrf-token: fetch` mediante GET a la URL del tenant y guarde el token en `cpi_csrf_token`, garantizando la ejecución autónoma tanto en Postman UI como en suites automatizadas Newman / CI/CD.
2. **Soporte de URL Base Configurable (`--base-url`)**: Configura la variable `CPI_TENANT_BASE_URL` en la colección Postman y los servidores en OpenAPI 3.0.3 a partir del host del tenant especificado por el usuario.
3. **Parámetros Externalizados en Endpoints (privacidad por defecto)**: Si el canal declara una dirección externalizada `{{param}}`, se conserva como variable `{{param}}` en Postman/OpenAPI. Los valores de `src/main/resources/parameters.prop` solo se leen con `--resolve-params` (opt-in explícito; `resolveParams: true` en MCP).
4. **Esquemas Duales XML y JSON en OpenAPI**: Infiere y publica ejemplos sintéticos tanto en `application/xml` como en `application/json` a partir de los contratos XSD empaquetados en el iFlow.


---

## 8. Reglas de Robustez y Contrato (LL-019 a LL-026)

| Código | Severidad | Regla | Descripción Técnica |
| :--- | :--- | :--- | :--- |
| `MCP-001` | `HIGH` | **Argumentos validados contra `inputSchema`** | Toda llamada `tools/call` comprueba `required` y los tipos declarados. Si falta un campo o el tipo es incorrecto, responde un error JSON-RPC `-32602` y no ejecuta la herramienta (nunca cae al demo). |
| `MCP-002` | `MEDIUM` | **Errores JSON-RPC 2.0** | JSON malformado → `-32700`; petición inválida o `null` → `-32600`; método, tool, resource o prompt desconocido → `-32601`/`-32602`. Los batches reciben un array de respuestas. `protocolVersion` se negocia contra `SUPPORTED_PROTOCOL_VERSIONS`. |
| `MCP-003` | `HIGH` | **Raíz fija del sandbox** | `setup-skills.mjs --mcp` escribe `env.CPI_MCP_ROOT` en `.mcp.json` para que el sandbox no dependa del cwd del cliente. La extracción vía MCP (`extractDir`) redacta los `.prop`. |
| `REGEX-001` | `HIGH` | **Dialecto Java** | Las regex se traducen de `java.util.regex` antes de evaluarlas (`(?i)` y demás flags inline, `a++`/`a*+`, `\Q..\E`, `\p{L}`, `\p{Alpha}`…). Lo que no tiene equivalente se reporta como error, sin evaluarlo mal. |
| `REGEX-002` | `HIGH` | **ReDoS por alternancia solapada** | `findOverlappingAlternation` marca grupos cuantificados cuyas alternativas se solapan (`^(a|aa)+$`, `(\d|\d\d)*`) sin necesidad de casos de prueba largos. |
| `CAMEL-001` | `HIGH` | **Camel Simple en CPI (Camel 3)** | Error: `${property.X}` (usa `${exchangeProperty.X}`) y `${In.Body}` (Simple distingue mayúsculas). Aviso: `${in.body}` (obsoleto, eliminado en Camel 4; usa `${body}`). |
| `DIFF-001` | `HIGH` | **Diff por contenido** | `diff-iflow-zip` compara entradas por hash, no por tamaño, y lista pasos añadidos/eliminados, parámetros eliminados y la versión del manifest en consola, JSON y PDF. |
| `XSD-001` | `CRITICAL` | **XSD bien formado y tipos resueltos** | Parser XML real: etiquetas desemparejadas, prefijos sin declarar, `type`/`base`/`ref` que no resuelven a un tipo XSD integrado o propio, declaraciones globales duplicadas y elementos hermanos con el mismo nombre y tipos distintos o anónimos (*Element Declarations Consistent*) son errores. |
| `XSD-002` | `HIGH` | **Nombres NCName en la inferencia** | `--infer` convierte claves JSON, `--root` y prefijos a NCName válidos (`toNCName`) y avisa de cada cambio. `--ns` se escapa. Entradas vacías, inexistentes, con BOM, raíz array o `{}` dan error con exit 1, nunca un XSD vacío. |
| `MMAP-001` | `MEDIUM` | **Mapeos y rutas del `.mmap`** | `--map` mal formado o flag desconocido → exit 2. `--source-xsd`/`--target-xsd` aceptan rutas Windows (`C:\…`). El simulador escapa una sola vez, resuelve XPath absolutas hijo a hijo y valida la salida contra `--target-xsd`. |
| `MOCK-001` | `HIGH` | **Mock suite estricta y reproducible** | XML validado con parser real. Las claves se correlacionan sin distinguir mayúsculas ni `_-.`. Con `--strict` los desajustes son errores. Sin `--timestamp` el ZIP es idéntico byte a byte. Si hay errores no se escribe nada. |
| `XSLT-001` | `CRITICAL` | **XSLT bien formado y prefijos declarados** | Parser XML real. La raíz debe ser `xsl:stylesheet`/`xsl:transform` con el namespace XSL y `version`. Los prefijos usados en elementos y en XPath deben estar declarados (se ignoran literales y ejes). |
| `XSLT-002` | `HIGH` | **Construcciones por motor (`--engine 1.0/2.0/3.0`)** | En 1.0: elementos 2.0/3.0, `as`, `#all`, funciones XPath 2.0, `if/then/else`, `for`, `some/every`, `instance of`, `xs:*()`, `*:name`, `to/except/intersect` (cada uno una vez y con línea). En 2.0: elementos solo 3.0. `json-to-xml()` y otras funciones 3.0 exigen 3.0. |
| `XSLT-003` | `HIGH` | **Variables y parámetros** | `$var` sin declarar (teniendo en cuenta `for`/`let`/`some`/`every`) y `xsl:param`/`xsl:variable` duplicados en el mismo ámbito son errores. `<xsl:param name="exchange"/>` debe ser de nivel superior. |
| `GROOVY-LIT-001` | `MEDIUM` | **Literales ignorados** | Las reglas estructurales de `validate-groovy` se evalúan sobre el código con los literales String enmascarados (`stripStringLiterals`), así que un patrón prohibido dentro de un texto no se marca. |
| `DOC-001` | `MEDIUM` | **Secciones con contenido** | `--validate-doc` exige las 8 secciones con contenido real: una sección vacía o con TBD, todo, pendiente o n/a es un error (exit 1). |
| `CLI-001` | `LOW` | **Contrato CLI uniforme** | `--help` → exit 0. Sin argumentos, o con flag desconocido o sin valor → exit 2 y uso en stderr. Entrada inválida → exit 1 con mensaje, nunca stack trace. Importar el módulo no imprime nada. |
