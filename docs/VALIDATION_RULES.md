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
| `IFLW-004` | `MEDIUM` | **Timeouts Explícitos en `ExternalCall`** | Verifica que todo paso `Request-Reply` (`ExternalCall`) tenga configurado un `httpConnectionTimeout` o `timeout` en su `messageFlow` asociado. |
| `IFLW-005` | `HIGH` | **Prevención de Fuga de Memoria en Content Modifier** | Bloquea el almacenamiento de `${body}` o `${in.body}` dentro de Exchange Properties o Headers en pasos `Enricher` (Content Modifier), ya que las propiedades persisten durante toda la vida del Exchange. |
| `IFLW-006` | `ADVISORY` | **Streaming en Splitters (`streaming=true`)** | Detecta pasos `Splitter` (`General`/`Iterating Splitter`) con `<key>streaming</key><value>false</value>`, recomendando activar streaming para evitar cargar lotes XML/JSON completos en memoria DOM. |
| `IFLW-007` | `ADVISORY` | **Ruta por Defecto en Routers (`default`)** | Verifica que todo `<bpmn2:exclusiveGateway>` defina su atributo `default` para evitar fallos por mensajes sin ruta coincidente. |
| `IFLW-008` | `ADVISORY` | **CPILint `CleartextBasicAuth` y `CsrfProtectionRequired`** | Detecta canales configurados con `BasicAuthentication` (recomendando OAuth2 / Client Certificate) o con `xsrfProtection=0` (CSRF deshabilitado). |
| `OSGI-001` | `CRITICAL` | **Raíz OSGi sin Carpeta Intermedia (`manifestIssues`)** | Verifica que `META-INF/MANIFEST.MF` esté exactamente en la raíz del `.zip` (`META-INF/MANIFEST.MF` y no `Subcarpeta/META-INF/MANIFEST.MF`). Evita el error `Upload the artifact failed. The project must contain a valid manifest file`. |
| `OSGI-002` | `CRITICAL` | **Límite de 72 Bytes UTF-8 por Línea en `MANIFEST.MF`** | Verifica que ninguna línea física de `META-INF/MANIFEST.MF` supere los 72 bytes UTF-8 y que las continuaciones inicien con espacio simple (`\r\n `). |

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
5. **Compatibilidad de Paquete `XmlSlurper` en Groovy 2.4 vs Groovy 4 (`GROOVY24_INVALID_XMLSLURPER_IMPORT`):** En el motor estándar Groovy 2.4 de SAP CPI (`com.sap.gateway.ip.core.customdev.util.Message`), `groovy.xml.XmlSlurper` no existe y provoca error de compilación `unable to resolve class groovy.xml.XmlSlurper`; debe usarse obligatoriamente `import groovy.util.XmlSlurper`. Solo en scripts Groovy 4 Script v2 (`com.sap.it.script.v2.api.Message`) debe usarse `import groovy.xml.XmlSlurper`.
6. **Prohibición de `Reader.getText(String charset)` (`READER_GETTEXT_CHARSET_ERROR`):** En Java y Groovy, `Reader` (`BufferedReader`, `StringReader`) ya es un flujo de caracteres y carece de método `.getText(String charset)`. Llamar a `bodyReader.getText('UTF-8')` lanza `MissingMethodException: No signature of method: java.io.BufferedReader.getText() is applicable for argument types: (java.lang.String) values: [UTF-8]`. Debe pasarse el `Reader` directamente a `.parse(bodyReader)` o llamarse `bodyReader.getText()` **sin argumentos**.
7. **Prevención de Fuga en Metaspace (`DYNAMIC_CODE_EVAL_OOM`):** Prohibido instanciar `GroovyShell` o `Eval.me()` en tiempo de ejecución, ya que genera ClassLoaders por cada mensaje hasta agotar la memoria Metaspace del Worker Node.
5. **Prohibición de `setBody` con 2 argumentos (`API-SETBODY-ARGS`):** `message.setBody(payload, Class)` no existe en la interfaz `Message` de SAP CPI; debe usarse únicamente `message.setBody(payload)`.
6. **Seguridad XML Anti-XXE (`SEC-XXE`):** Todo uso de `XmlSlurper` o `XmlParser` debe deshabilitar DTDs externos mediante `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`. El analizador de comentarios preserva literales URL (`http://`, `https://`) para evitar falsos positivos al verificar features SAX/DOM.
7. **Inmutabilidad y Seguridad de Hilos en `@Field` (`MUTABLE_FIELD_STATE`):** Si se emplea `@Field` (`groovy.transform.Field`) para constantes a nivel de script, debe declararse obligatoriamente con `final` (`@Field final`). Un `@Field` mutable se comparte entre hilos concurrentes del worker node provocando condiciones de carrera.
8. **Gestión de Zona Horaria (`TZ-DEFAULT`):** Prohibido usar `new Date()` o `LocalDateTime.now()` sin `ZoneId.of("UTC")` explícito.
9. **Higiene del Message Processing Log (`MPL-UNCONDITIONAL`):** Todo `addAttachmentAsString` debe ejecutarse únicamente dentro de bloques `catch` o condicionado a `SAP_MessageProcessingLogLevel` (`DEBUG` / `TRACE`).

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

## 5. Reglas de Esquemas W3C XSD 1.0 (`validate-xsd.mjs`)

1. **Prohibición de `<xsd:all>`:** El motor gráfico de Message Mapping de SAP CPI presenta limitaciones severas con `<xsd:all>`; todos los elementos hijos complejos deben modelarse con `<xsd:sequence>`.
2. **Prevención de *Namespace Prefix Conflict*:** Cuando el esquema define `targetNamespace`, exige declarar también el prefijo propio (`xmlns:tns="..."`) junto con `elementFormDefault="qualified"`.
3. **Compatibilidad `nillable="true"` + `minOccurs="0"` (SAP Note 2624922):** Advierte cuando un elemento declara `nillable="true"` sin `minOccurs="0"`, ya que el *JSON to XML Converter* de SAP CPI puede omitir etiquetas nulas en lugar de emitir `xsi:nil="true"`.
4. **Límite de Nodos:** Verifica que el esquema no supere los `20.000` nodos XML para evitar bloqueos de memoria en el editor de mapeos.

---

## 6. Reglas de Empaquetado OSGi (`build-cpi-package.mjs` y `clone-iflow-bundle.mjs`)

Para que un paquete iFlow + Script Collection sea importable sin errores en SAP Integration Suite (`Upload the artifact failed. The project must contain a valid manifest file`):
- **Estructura en Raíz del ZIP (`stripRootFolderPrefix`)**: `.project`, `metainfo.prop`, `META-INF/MANIFEST.MF` y `src/main/resources/...` deben residir directamente en la raíz del archivo `.zip`, sin ninguna carpeta contenedora intermedia, y ordenados con `.project` y `META-INF/MANIFEST.MF` al inicio del archivo.
- **Plegado a 72 Bytes UTF-8 (`wrapManifestLine72`)**: Las líneas de `META-INF/MANIFEST.MF` nunca deben superar los **72 bytes UTF-8**; las continuaciones deben dividirse con `\r\n ` (CRLF + espacio inicial) y finalizar con línea en blanco (`\r\n\r\n`).
- El `MANIFEST.MF` del **Script Collection** debe declarar `Provide-Capability: scriptcollection.<SC_ID>;version:Version="1.0.0"`.
- El `MANIFEST.MF` del **Integration Flow** debe declarar `Require-Capability: scriptcollection.<SC_ID>;filter:="(&(version>=1.0.0))"` (o `resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`) y `SAP-BundleType: IntegrationFlow`.
- En el archivo `.iflw`, todo paso de script que invoque una Script Collection debe incluir `<ifl:property><key>scriptBundleId</key><value><SC_ID></value></ifl:property>`.
- **Subida Individual**: Cada `.zip` (`<ScriptCollection>.zip` y `<Iflow>.zip`) debe importarse individualmente en SAP CPI, nunca subiendo un `.zip` contenedor que agrupe varios archivos `.zip`.
