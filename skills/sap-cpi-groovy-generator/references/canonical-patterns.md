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
