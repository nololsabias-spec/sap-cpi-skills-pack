# Catálogo de Directivas Modulares y Condiciones Técnicas SAP CPI

## 1. Las 10 Directivas Modulares (`CPI_DIRECTIVES`)

1. **`xmlSlurper` (XXE Protection & Streaming)**:
   - Prohibido `XmlParser` y `message.getBody(String)`.
   - Obtener reader UTF-8: `Reader reader = message.getBody(java.io.Reader)` (nunca llamar a `reader.getText('UTF-8')` porque `Reader.getText()` en Groovy no acepta parámetros de charset y lanza `MissingMethodException`; pasar `reader` directo a `.parse(reader)` o usar `reader.getText()` sin argumentos).
   - Parsear con `XmlSlurper` seguro (`import groovy.util.XmlSlurper` en Groovy 2.4 Script v1; `import groovy.xml.XmlSlurper` solo en Groovy 4 Script v2) deshabilitando entidades externas y DOCTYPE:
     ```groovy
     def parser = new XmlSlurper(false, false)
     parser.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
     parser.setFeature("http://xml.org/sax/features/external-general-entities", false)
     parser.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
     def xml = parser.parse(reader)
     ```
   - Construir XML de salida con `groovy.xml.StreamingMarkupBuilder` o `MarkupBuilder`.
   - Fijar cabecera: `message.setHeader('Content-Type', 'application/xml; charset=utf-8')`.

2. **`jsonProcessing` (`JsonSlurperClassic` & Streaming)**:
   - Usar obligatoriamente `groovy.json.JsonSlurperClassic`:
     ```groovy
     Reader reader = message.getBody(java.io.Reader)
     def json = new groovy.json.JsonSlurperClassic().parse(reader)
     ```
   - Construir salida con `groovy.json.JsonBuilder` o `JsonOutput`:
     ```groovy
     message.setHeader('Content-Type', 'application/json; charset=utf-8')
     message.setBody(new groovy.json.JsonBuilder(rootNode).toString())
     ```

3. **`explicitTimezone` (Timezone Safe - UTC)**:
   - Prohibido `TimeZone.getDefault()` o `new Date().format(...)`.
   - Usar siempre `java.time.*` con `ZoneId.of("UTC")`:
     ```groovy
     DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneId.of("UTC"))
     String timestampUtc = formatter.format(Instant.now())
     ```

4. **`mplGovernance` (Observabilidad & MPL Governance)**:
   - Obtener log con `def messageLog = messageLogFactory?.getMessageLog(message)`.
   - Indexar claves de negocio con `messageLog?.addCustomHeaderProperty('BusinessDocID', idValue)`.
   - Attachments solo condicionales:
     ```groovy
     if (message.getProperty('LogAttachments') == 'Yes') {
         messageLog?.addAttachmentAsString('Payload_Debug', payloadText, 'application/json')
     }
     ```

5. **`upgradeReadiness` (Ensure Upgrade Readiness & Engine Compatibility)**:
   - Incluir única y exclusivamente los imports utilizados en el script.
   - Prohibidos comodines (`import java.util.*`).
   - Prohibidas clases internas de Camel (`org.apache.camel.impl.*`).
   - En scripts Groovy 2.4 (`com.sap.gateway.ip.core.customdev.util.Message`), usar siempre `import groovy.util.XmlSlurper` (nunca `import groovy.xml.XmlSlurper`, que falla al compilar con `unable to resolve class groovy.xml.XmlSlurper`). En Groovy 4 Script v2 (`com.sap.it.script.v2.api.Message`), usar `import groovy.xml.XmlSlurper`.
   - Prohibido invocar `reader.getText('UTF-8')` sobre un `Reader` (`BufferedReader` / `StringReader`), ya que en Groovy `Reader.getText()` no admite argumento de codificación y lanza `MissingMethodException`.

6. **`headersProperties` (Headers & Exchange Properties)**:
   - Prohibido sobrescribir prefijos reservados `Camel*` y `SAP_*`.
   - Solo almacenar tipos serializables en Properties (prohibido guardar nodos `GPathResult`, `DOM Nodes` o `Streams` abiertos).

7. **`secureStore` (Credential Governance)**:
   - Prohibido hardcodear credenciales, tokens o secretos.
   - Usar:
     ```groovy
     def service = com.sap.it.api.ITApiFactory.getApi(com.sap.it.api.securestore.SecureStoreService.class, null)
     def cred = service?.getUserCredential("AliasNombre")
     ```

8. **`valueMapping` (Value Mapping API)**:
   - Prohibidos `switch/case` masivos para catálogos.
   - Usar:
     ```groovy
     def vmApi = com.sap.it.api.ITApiFactory.getApi(com.sap.it.api.mapping.ValueMappingApi.class, null)
     String mapped = vmApi?.getMappedValue(srcAgency, srcId, srcVal, tgtAgency, tgtId)
     ```

9. **`attachments` (Binary Attachments)**:
   - Usar `javax.activation.DataHandler` y `javax.mail.util.ByteArrayDataSource` con `message.getAttachments()` y `message.addAttachmentObject(id, dataHandler)`.

10. **`exceptionHandling` (Resilience `CPI-ERR`)**:
    - Envolver en `try / catch (Exception e) / finally`.
    - Relanzar siempre con: `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.
