# Referencia One-Shot Refactor y Sistema de Puntuación SAP CPI

## Sistema de Puntuación Oficial (Base: 100 Puntos)
- **Severidad CRÍTICA (-30 pts c/u)**:
  - Vulnerabilidad XXE (`XmlSlurper` / `DocumentBuilderFactory` sin `disallow-doctype-decl = true`).
  - Variables estáticas (`static def`, `static Map`, `static List`) que retienen memoria entre mensajes en el worker node.
  - Heap OOM por `message.getBody(String)` o `new XmlParser()`.
- **Severidad ALTA (-15 pts c/u)**:
  - Uso de `groovy.json.JsonSlurper` en lugar de `groovy.json.JsonSlurperClassic`.
  - Uso de `TimeZone.getDefault()` o formateo de fecha sin zona horaria explícita UTC.
  - Streams o `Reader` sin cerrar en bloque `finally` o `.withReader`.
  - Bloques `catch` vacíos que silencian excepciones ante el Exception Subprocess.
  - Credenciales, contraseñas o tokens hardcodeados en el script.
- **Severidad MEDIA (-5 pts c/u)**:
  - Creación incondicional de MPL Attachments (`addAttachmentAsString`) en cada ejecución normal.
  - Imports no utilizados o con comodines (`import java.util.*`).
  - Clases deprecadas (`groovy.util.XmlSlurper`).
  - Sobrescribir cabeceras reservadas (`Camel*`, `SAP_*`).
  - Llamada a `message.setBody()` con más de un argumento.
- **Severidad BAJA (-2 pts c/u)**:
  - Falta de prefijo `'CPI-ERR: '` al relanzar excepciones.
  - No especificar `charset=utf-8` en cabecera `Content-Type`.

---

## Ejemplo Canónico One-Shot (Before / After)

### Entrada Vulnerable (`Score: 0/100`)
```groovy
import com.sap.gateway.ip.core.customdev.util.Message
import java.util.*
import groovy.json.JsonSlurper
import groovy.xml.XmlParser

static def cacheMap = [:]

def Message processData(Message message) {
    String payload = message.getBody(String)
    def json = new JsonSlurper().parseText(payload)
    def root = new XmlParser().parseText(payload)
    def dateStr = new Date().format("yyyy-MM-dd HH:mm:ss")
    
    def messageLog = messageLogFactory.getMessageLog(message)
    messageLog.addAttachmentAsString("Payload", payload, "application/json")
    
    cacheMap.put(System.currentTimeMillis(), payload)
    
    try {
        message.setHeader("ProcessedAt", dateStr)
    } catch(Exception e) {}
    
    return message
}
```

### Salida Refactorizada Perfecta (`Score: 100/100`)
```groovy
import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurperClassic
import groovy.json.JsonBuilder
import java.io.Reader
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

def Message processData(Message message) {
    def messageLog = messageLogFactory?.getMessageLog(message)
    Reader bodyReader = message.getBody(java.io.Reader)
    
    if (bodyReader == null) {
        return message
    }

    try {
        // 1. Timezone explícito UTC (Avoid Default Timezone)
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneId.of("UTC"))
        String timestampUtc = formatter.format(Instant.now())
        
        // 2. Parsing seguro con JsonSlurperClassic (Anti-Heap Leak)
        def json = new JsonSlurperClassic().parse(bodyReader)
        
        // 3. Modificación defensiva de headers y properties
        message.setHeader("ProcessedAt", timestampUtc)
        message.setProperty("Status", "SUCCESS")
        
        // 4. Indexar métricas de negocio sin saturar la BD de logs
        def businessId = message.getHeader("OrderId", String) ?: json?.orderId ?: "N/A"
        messageLog?.addCustomHeaderProperty("BusinessDocID", businessId.toString())
        
        // 5. Attachments condicionales en MPL (solo si existe flag explícito)
        if (message.getProperty("LogAttachments") == "Yes") {
            messageLog?.addAttachmentAsString("Debug_Payload", new JsonBuilder(json).toPrettyString(), "application/json")
        }

        message.setHeader("Content-Type", "application/json; charset=utf-8")
        message.setBody(new JsonBuilder(json).toString())
        return message
    } catch (Exception e) {
        messageLog?.addAttachmentAsString("Error_Trace", "Error: " + e.getMessage(), "text/plain")
        throw new Exception("CPI-ERR: " + e.getMessage(), e)
    } finally {
        bodyReader.close()
    }
}
```
