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

## Pattern F: Upsert POST/PATCH sobre OData V4 (`decidir, leer claves, un PATCH por línea`)
Cuando el origen puede reenviar una entidad que ya existe en el destino y hay que crearla solo si falta. Validado en un tenant: la forma anidada del PATCH **no** funciona.

1. **Guardar el XML original** en una propiedad antes de cualquier llamada (la respuesta sustituye al body).
2. **Decidir con una consulta ligera**: `$filter=<CampoCabecera> eq '${property.Clave}'&$select=<Clave>,<FechaUltimoCambio>`, sin `$expand`. Un script (Groovy, `JsonSlurperClassic`) pone una propiedad para el Router y elige el documento con la fecha de cambio más reciente. Nombra la propiedad de modo que su `true` signifique lo que el Router espera.
3. **Router**: ruta *crear* (POST con el batch de siempre) y ruta *modificar* como Default.
4. **Leer las claves por clave**: GET `<EntidadCabecera>('<id>')` con `$expand=<NavPosiciones>($expand=<NavLineas>)`. Es la única llamada que trae los números internos de posición y línea. No lo hagas filtrando por pedido sobre todos los documentos: puede agotar el timeout.
5. **Script de PATCH** (Groovy, `XmlSlurper` con XXE desactivado, `StreamingMarkupBuilder`, lectura por `Reader`): acepta la respuesta en JSON o XML; empareja cada posición del mensaje con la del documento por clave de negocio normalizada (sin ceros a la izquierda) y genera **un único `batchChangeSet1` con un `batchChangeSetPartN` por línea** (la documentación de la API exige que todos los cambios de un mismo documento vayan en un solo change set; los documentos de distintos pedidos van en change sets distintos) con una URI de clave nombrada, `<EntidadLinea>(Campo1='a',Campo2='b',Campo3='c')`, y un cuerpo plano con solo los campos que cambian. Si ninguna posición existe, pon `...Skipped='true'` con el motivo y devuelve el XML original para que un Router decida (error o crear); si el documento no trae posiciones, falla con `CPI-ERR`.
6. **Respuesta**: recorre todos los `statusCode` de las partes del `$batch` (el 200 externo no basta); un aviso con severidad 3 no es un error.
7. **Comprobaciones**: con todo nuevo, el batch debe ser idéntico al anterior; el PATCH debe probarse en DEV (¿sustituye la línea o la añade? ¿pide `If-Match`? ¿admite un cambio a una fecha pasada?). Un caso mixto (algunas posiciones no existen) hay que decidirlo de forma explícita: error o crear solo esas.

Antes de diseñar el patrón para otra API, lee su página oficial (restricciones, claves y *Necessity* de cada campo): `skills/sap-cpi-architect/references/s4hana-api-docs.md` explica cómo leer la ayuda de SAP sin navegador y resume lo aplicable a todas las APIs.

Probar la lógica de los scripts en local con Groovy 2.4 (`apt-get install groovy` instala la 2.4.x) y un `Message` simulado con el mismo nombre de clase, con casos de error: sin id, clave con comilla, cuerpo vacío, XML mal formado y XXE.
