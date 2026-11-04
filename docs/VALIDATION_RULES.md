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

---

## 2. Reglas de Validación y Scoring para Scripts Groovy

Aplicadas por `validate-groovy.mjs` y `audit-groovy.mjs`.

### 2.1. Fórmula de Puntuación (Score 0 - 100)
Todo script parte de **100 puntos** y se restan puntos según la severidad de cada hallazgo:
- **CRÍTICA (`CRITICAL`):** `-30` puntos
- **ALTA (`HIGH`):** `-15` puntos
- **MEDIA (`MEDIUM`):** `-5` puntos
- **BAJA (`LOW`):** `-2` puntos

### 2.2. Reglas Base y *Ensure Upgrade Readiness*
1. **Firma Oficial:** Debe declarar `import com.sap.gateway.ip.core.customdev.util.Message` y `def Message processData(Message message)` retornando `message`.
2. **Prohibición de Wildcards (`UPGRADE-WILDCARD`):** Prohibido usar `import paquete.*`. Toda clase debe importarse explícitamente para superar el chequeo *Ensure Upgrade Readiness* de SAP CPI.
3. **Cero Imports No Utilizados (`UPGRADE-UNUSED-IMPORT`):** Todo `import` declarado debe referenciarse en el cuerpo del script.
4. **Prohibición de APIs Internas de Apache Camel (`UPGRADE-INTERNAL-CAMEL`):** Prohibido importar `org.apache.camel.impl.*` o `org.apache.camel.support.*` debido a cambios incompatibles entre Camel 2.x y Camel 3.x+.
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
4. **Funciones de Extensión SAP CPI (`--scenario=headers`):** Exige declarar `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"`, `exclude-result-prefixes="cpi"` y `<xsl:param name="exchange"/>`.

---

## 4. Reglas de Expresiones Regulares y Apache Camel (`test-camel-regex.mjs`)

1. **Anclaje Estricto:** Toda expresión regular de validación debe iniciar con `^` y finalizar con `$` para evitar coincidencias parciales accidentales en el Router de SAP CPI.
2. **Prevención de ReDoS (*Catastrophic Backtracking*):** Detecta cuantificadores anidados ambiguos como `(.+)+`, `(.*)+` o `([a-zA-Z]+)*` que pueden bloquear los hilos de trabajo del tenant SAP CPI.

---

## 5. Reglas de Esquemas W3C XSD 1.0 (`validate-xsd.mjs`)

1. **Prohibición de `<xsd:all>`:** El motor gráfico de Message Mapping de SAP CPI presenta limitaciones severas con `<xsd:all>`; todos los elementos hijos complejos deben modelarse con `<xsd:sequence>`.
2. **Prevención de *Namespace Prefix Conflict*:** Cuando el esquema define `targetNamespace`, exige declarar también el prefijo propio (`xmlns:tns="..."`) junto con `elementFormDefault="qualified"`.
3. **Límite de Nodos:** Verifica que el esquema no supere los `20.000` nodos XML para evitar bloqueos de memoria en el editor de mapeos.

---

## 6. Reglas de Empaquetado OSGi (`build-cpi-package.mjs`)

Para que un paquete iFlow + Script Collection sea importable sin errores en SAP Integration Suite:
- El `MANIFEST.MF` del **Script Collection** debe declarar `Provide-Capability: scriptcollection.<SC_ID>;version:Version="1.0.0"`.
- El `MANIFEST.MF` del **Integration Flow** debe declarar `Require-Capability: scriptcollection.<SC_ID>;filter:="(&(version>=1.0.0))"` y `SAP-BundleType: IntegrationFlow`.
- Las líneas de `META-INF/MANIFEST.MF` nunca deben superar los **72 bytes UTF-8** sin continuación por espacio inicial.
- En el archivo `.iflw`, todo paso de script que invoque una Script Collection debe incluir `<ifl:property><key>scriptBundleId</key><value><SC_ID></value></ifl:property>`.
