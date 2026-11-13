# Los 5 Patrones Arquitectónicos Canónicos de Groovy para SAP CPI

## Pattern A: XML Large Payload Streaming (`Heap Safe / High Performance`)
Procesamiento de XML masivo sin saturar el Heap Memory usando `XmlSlurper` seguro con XXE deshabilitado e `InputStreamReader` / `Reader`.

```groovy
import com.sap.gateway.ip.core.customdev.util.Message
import groovy.util.XmlSlurper
import groovy.xml.StreamingMarkupBuilder
import java.io.Reader

def Message processData(Message message) {
    def messageLog = messageLogFactory?.getMessageLog(message)
    Reader reader = message.getBody(java.io.Reader)
    if (reader == null) {
        return message
    }
    try {
        def parser = new XmlSlurper(false, false)
        parser.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        parser.setFeature("http://xml.org/sax/features/external-general-entities", false)
        parser.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        def root = parser.parse(reader)

        BigDecimal totalAmount = 0.0G
        int itemCount = 0
        root.Item.each { item ->
            BigDecimal qty = (item.@qty?.text() ?: "0") as BigDecimal
            BigDecimal price = (item.@price?.text() ?: "0.0") as BigDecimal
            totalAmount += (qty * price)
            itemCount++
        }

        message.setProperty("TotalItems", itemCount)
        message.setProperty("TotalAmount", totalAmount.toPlainString())
        messageLog?.addCustomHeaderProperty("TotalItems", itemCount.toString())

        def builder = new StreamingMarkupBuilder()
        builder.encoding = "UTF-8"
        String outXml = builder.bind {
            OrderSummary(totalItems: itemCount, totalAmount: totalAmount.toPlainString())
        }.toString()

        message.setHeader("Content-Type", "application/xml; charset=utf-8")
        message.setBody(outXml)
        return message
    } catch (Exception e) {
        messageLog?.addAttachmentAsString("Error_Trace", "Error: " + e.getMessage(), "text/plain")
        throw new Exception("CPI-ERR: " + e.getMessage(), e)
    } finally {
        reader.close()
    }
}
```

## Pattern B: Headers & Exchange Properties (`State & Context`)
Lectura tipada null-safe, sanitización de cabeceras sensibles salientes y propagación de `X-Correlation-ID` y timestamps UTC.

## Pattern C: MPL Logging & Attachments (`Observability / Debug`)
Registro gobernado de métricas con `addCustomHeaderProperty` y adjuntos estrictamente condicionales (`LogAttachments == 'Yes'` o bloque `catch`).

## Pattern D: JSON Manipulation (`JsonSlurperClassic` + `JsonBuilder`)
Transformación y enriquecimiento estructurado de payloads JSON por streaming con `JsonSlurperClassic` y salida UTF-8.

## Pattern E: Custom Base64 / HMAC-SHA256 & SecureStore (`Security / Crypto`)
Obtención de secretos mediante `ITApiFactory` + `SecureStoreService` y firma criptográfica `HmacSHA256` en `Base64`.

## Pattern F: Upsert POST/PATCH sobre OData V4 (`Plan en Groovy + batch en XSLT`)
Cuando el origen puede reenviar una entidad que ya existe en el destino y hay que crearla solo si falta:

1. **Consulta** (HTTP o adaptador OData) por la clave de cabecera con `$expand` hacia las posiciones: `$filter=<CampoCabecera> eq '${property.Clave}'&$expand=<NavegaciónPosiciones>`. Guarda el XML original en una propiedad antes de llamar (el body se sustituye por la respuesta). Asigna `Clave` con un Content Modifier XPath **antes** de la consulta.
2. **Script de plan** (Groovy, `XmlSlurper` + `StreamingMarkupBuilder`, nunca `XmlParser`): indexa la respuesta por clave de posición normalizada (sin ceros a la izquierda), con el documento más reciente por `LastChangeDateTime` como ganador. Para cada posición del mensaje: si está indexada, va a `<Update id="documento">`; si no, a un único `<Create>`. Si hay documentos pero ninguno trae las posiciones, lanza `CPI-ERR` (nunca crees a ciegas). Sin posiciones en el mensaje, conserva el comportamiento anterior (un `Create` con la cabecera).
3. **XSLT 1.0**: una pareja `batchChangeSetN/batchChangeSetPartN` por operación; `Create` → `POST <EntitySet>` y `Update` → `PATCH <EntitySet>('<id>')` con `If-Match: *`. Reutiliza las plantillas de mapeo de campos del POST sin cambios.
4. **Comprobaciones**: con todo nuevo, el batch debe ser idéntico al del XSLT anterior (regresión por canonicalización); el PATCH debe probarse en DEV (¿sustituye la línea o la añade? ¿acepta `If-Match: *`?).
5. **Respuesta**: reutiliza el script de detección de errores del POST si ya reconoce los códigos 200 y 201.

Probar la lógica del script en local con Groovy 2.4 (`apt-get install groovy` instala la 2.4.x) y un `Message` simulado con el mismo nombre de clase, y el XSLT con el procesador de la JDK (`javax.xml.transform`).
