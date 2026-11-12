# Regla de Documentación de Código — SAP CPI (Groovy y XSLT)

Esta regla aplica **siempre** que:
1. **Generes** un script Groovy o una hoja XSLT (`sap-cpi-groovy-generator`, `sap-cpi-xslt-studio`, `sap-cpi-architect`).
2. **Refactorices** un script durante una auditoría (`sap-cpi-code-auditor`) y vayas a añadir o cambiar comentarios.
3. El usuario **pida comentar o documentar** un script o una hoja que ya existe.

Todos los artefactos se documentan con el mismo formato, así que cualquier persona (o agente) encuentra lo mismo en el mismo sitio. El formato se comprueba por código: `--docs` en `validate-groovy.mjs`, `audit-groovy.mjs` y `validate-xslt.mjs`, o `docs: true` en las herramientas MCP. No se entrega nada sin **0 hallazgos CRITICAL/HIGH/MEDIUM** de documentación.

---

## 1. Principios (de dónde sale el estándar)

| Principio | Origen |
| :--- | :--- |
| El artefacto debe entenderse sin abrir el iFlow: qué hace, qué lee y qué escribe. | Directriz SAP *Keep Readability in Mind* (Integration Flow Design Guidelines). |
| Un script solo se justifica si un paso estándar no basta; se deja escrito el **motivo**. | Directriz SAP *Use Scripting Appropriately*. |
| Bloques `/** ... */` delante del elemento, frase de resumen primero y etiquetas `@` al final. | Groovydoc sigue las convenciones de Javadoc (documentación oficial de Groovy). |
| Nada de `///`: los comentarios Markdown de documentación son de Groovy 5 / JEP 467, no del runtime de CPI (Groovy 2.4 y 4). | Documentación de Groovydoc. |
| Ni secretos, ni endpoints, ni datos personales en comentarios: viajan con el export, las Script Collections y Git. | Guía de seguridad de SAP CPI (no exponer información sensible desde scripts) y regla de privacidad del pack. |
| Scripts limpios: sin código comentado ni restos de depuración. | SAP *Ensure Upgrade Readiness* y comprobaciones estáticas de estilo. |
| Versión y fecha en cada cambio. | Práctica habitual de los changelogs de paquetes SAP y de los estándares de nomenclatura de CPI. |

---

## 2. Cabecera de un script Groovy (obligatoria)

Va en la **línea 1**, antes de los `import`, para que se vea nada más abrir el script en el editor de CPI.

```groovy
/**
 * Calcula el importe total del pedido y lo publica en la propiedad TotalAmount.
 *
 * Motivo: el redondeo por línea con BigDecimal no se puede hacer en un Content Modifier.
 *
 * Paso Script: Groovy 4 (Script step 2.x) · API v2
 *
 * Entrada:
 *   - Body: XML Order/Item con @qty y @price (leído como Reader)
 *   - Property SAP_ApplicationID: clave de negocio (opcional).
 * Salida:
 *   - Body: application/xml; charset=utf-8 — OrderSummary
 *   - Property TotalAmount: importe total con 2 decimales.
 *   - MPL custom header TotalItems
 * Errores:
 *   - CPI-ERR: payload vacío o no parseable → Exception Subprocess
 *
 * Historial:
 *   - 1.1.0  2026-11-12  Redondeo HALF_UP por línea.
 *   - 1.0.0  2026-10-01  Versión inicial.
 *
 * @version 1.1.0
 */
import com.sap.it.script.v2.api.Message
```

### Campos, en este orden

| Campo | Obligatorio | Formato |
| :--- | :--- | :--- |
| Resumen | Sí | Una frase en presente, ≤ 140 caracteres, terminada en punto. Dice **qué** hace, no cómo. |
| `Motivo:` | Recomendado | Por qué hace falta un script y no un paso estándar. |
| `Paso Script:` | Sí | `Groovy 2.4 (Script step 1.x)` o `Groovy 4 (Script step 2.x)`, más `· API v1` o `· API v2`. Debe coincidir con `--groovy` y con el `import` del `Message`. |
| `Entrada:` | Sí | Lista `- Tipo Nombre: descripción`. Tipos: `Body`, `Header`, `Property`, `Adjuntos`, `Security Material`, `Value Mapping`, `Partner Directory`. `- Ninguna.` si no aplica. |
| `Salida:` | Sí | Igual que Entrada. Tipos: `Body` (con su Content-Type), `Header`, `Property`, `MPL custom header`, `MPL adjunto`. `- Sin cambios en el mensaje.` si no aplica. |
| `Errores:` | Si el código lanza excepciones | `- CPI-ERR: causa → Exception Subprocess` o `- Excepción: causa`. |
| `Historial:` | Sí | `- X.Y.Z  AAAA-MM-DD  Qué cambió.` La **más reciente primero**. |
| `@version` | Sí | Última línea. `X.Y.Z`, igual a la primera entrada del historial. |

Reglas adicionales:
- Las etiquetas van en español (`Entrada`, `Salida`…). También se aceptan sus equivalentes en inglés (`Input`, `Output`, `Errors`, `History`, `Script step`), pero no se mezclan los dos idiomas en un mismo archivo.
- El texto libre va en el idioma del proyecto o del usuario. Usa siempre el mismo dentro del archivo.
- **Autoría**: si se pide, `@author` con un rol o equipo ("Equipo Integración"), nunca un email ni un nombre de cliente.
- No pongas valores de `.prop`, URLs reales, IPs, usuarios ni alias de credenciales de producción. Describe el sistema por su rol ("API de pedidos del ERP").

### Esqueleto automático

Con un script ya escrito, deduce la cabecera del código y complétala:

```bash
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script.groovy> --doc-header --groovy 4            # imprime el esqueleto
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script.groovy> --doc-header --groovy 4 --out <nuevo.groovy>
```

El esqueleto rellena `Entrada`, `Salida` y `Errores` con lo que encuentra en el código (`getProperty`, `getHeader`, `getBody`, `setBody` + `Content-Type`, `setProperty`, `setHeader`, `addCustomHeaderProperty`, `addAttachmentAsString`, `getUserCredential`, `throw`). Lo que no puede deducir lo deja como `TODO`, y `--docs` no aprueba la cabecera hasta que se completa (`DOC_PLACEHOLDER`). Añade tú la descripción de cada elemento y el `Motivo:`.

---

## 3. Métodos auxiliares (Groovydoc)

Todo método declarado en el script, salvo `processData`, lleva un bloque `/** ... */` justo encima:

```groovy
/**
 * Recorta un valor a una longitud máxima sin fallar con null.
 *
 * @param value texto de entrada (puede ser null)
 * @param max   longitud máxima
 * @return el texto recortado, o null si value es null
 * @throws IllegalArgumentException si max es negativo
 */
String truncate(String value, int max) {
```

- Primero va la frase de resumen. Después, un `@param` por cada parámetro, con el mismo nombre y en el mismo orden que la firma. Luego `@return` si el método devuelve un valor y `@throws` si lanza excepciones.
- `processData` queda documentado por la cabecera, así que no necesita otro bloque.
- Para referirte a código dentro del texto, usa `{@code ...}`.

---

## 4. Comentarios en línea (`//`)

**Sí:**
- Explican el **porqué**: una regla de negocio, una limitación de CPI o un valor elegido. Ejemplo: `// 60 s de margen: el token caduca en el receptor antes que aquí.`
- Van en su propia línea, encima del código, con la misma sangría que el código.
- Los pasos numerados (`// 1. ...`, `// 2. ...`) están permitidos en scripts largos para seguir el flujo.

**No:**
- Repetir el código (`// asigna la propiedad` encima de `setProperty`).
- Dejar código comentado (`DOC_COMMENTED_OUT_CODE`). El historial ya está en Git y en las versiones del artefacto.
- Dejar `TODO` o `FIXME` en lo que se entrega (`DOC_TODO_LEFT`).
- Usar banners decorativos `// =====` (`DOC_BANNER_COMMENT`). Esa información va en la cabecera.
- Usar `///` (`DOC_MARKDOWN_DOC_COMMENT`).
- Poner emails, endpoints reales, IPs (`DOC_SENSITIVE_COMMENT`, HIGH) o secretos (`DOC_SECRET_IN_COMMENT`, CRITICAL). Se pueden usar hosts de ejemplo (`*.example.com`, `*.invalid`), rangos de IP de documentación y enlaces a `help.sap.com`, `w3.org` o `apache.org`.

---

## 5. Cabecera de una hoja XSLT

Es un comentario XML entre `<?xml ...?>` y `<xsl:stylesheet>`. **No** uses `<xsl:comment>`, porque ese elemento escribe el comentario en el mensaje de salida.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Agrupa los registros por OrderId y añade el sistema emisor.

  Motor: XSLT 2.0 (Saxon-HE)

  Entrada:
    - Body: XML con //Record (OrderId, ItemId, Quantity).
  Parámetros:
    - exchange: inyectado por CPI.
    - targetCurrency: property TargetCurrency, moneda de salida.
  Salida:
    - Body: XML BatchedOrders/Order/Items/Item.

  Historial:
    - 1.0.0  2026-11-12  Versión inicial.

  @version 1.0.0
-->
<xsl:stylesheet version="2.0" ...>
```

- `Motor:` debe coincidir con el atributo `version` de la hoja (o con `--engine`): `XSLT 1.0 (Xalan)` o `XSLT 2.0/3.0 (Saxon-HE)`.
- `Parámetros:` es obligatorio si hay algún `xsl:param` además de `exchange`, y debe nombrarlos todos.
- `Errores:` es obligatorio si se usa `<xsl:message terminate="yes">`.
- Las plantillas complejas llevan un `<!-- ... -->` de una línea encima que explique el porqué. No dejes plantillas comentadas.

---

## 6. Versionado

`MAJOR.MINOR.PATCH`:
- **PATCH**: corrección que no cambia el contrato.
- **MINOR**: funcionalidad nueva compatible, como una salida opcional nueva.
- **MAJOR**: cambio de contrato, por ejemplo una entrada nueva obligatoria, un formato de body distinto o una propiedad que se elimina.

Cada cambio añade una entrada **al principio** de `Historial:` y actualiza `@version`. Si el iFlow tiene versión propia, puedes citarla en la entrada del historial.

---

## 7. Flujo obligatorio

**Al generar** (Groovy):
1. Pregunta, si falta: runtime (2.4 o 4), contrato de entrada y salida, y errores.
2. Escribe la cabecera completa y el Groovydoc de cada método auxiliar.
3. Ejecuta `validate-groovy.mjs <script> --groovy <v> --docs`. Debe dar 100/100.

**Al auditar o refactorizar**:
1. Audita sin `--docs` para obtener el score técnico original, salvo que el usuario haya pedido la documentación.
2. Si añades o cambias comentarios, el refactor debe pasar `audit-groovy.mjs <orig> --refactored <ref> --groovy <v> --docs`.
3. Sube `@version` y añade la entrada de historial correspondiente.

**Cuando el usuario pida comentar un script existente**:
1. `--doc-header` para obtener el esqueleto.
2. Completa los `TODO` y las descripciones a partir del código y de lo que te diga el usuario. No inventes contratos: si no sabes algo, pregúntalo.
3. Añade Groovydoc a los métodos y comentarios `//` solo donde haya un porqué que explicar. No toques la lógica.
4. Valida con `--docs`.

**XSLT**: `validate-xslt.mjs <hoja> --engine <v> --docs`.

---

## 8. Reglas comprobadas por código

| Código | Severidad | Qué detecta |
| :--- | :--- | :--- |
| `DOC_MISSING_HEADER` / `XSLT_DOC_MISSING_HEADER` | MEDIUM | No hay cabecera al principio del archivo. |
| `DOC_PLACEHOLDER` / `XSLT_DOC_PLACEHOLDER` | MEDIUM | La cabecera tiene `TODO`, `FIXME`, `TBD` o `XXX`. |
| `DOC_RUNTIME_MISMATCH` / `XSLT_DOC_RUNTIME_MISMATCH` | MEDIUM (LOW si está incompleto) | `Paso Script:` o `Motor:` no coinciden con el código o con `--groovy`/`--engine`. |
| `DOC_SECRET_IN_COMMENT` | CRITICAL | Password, token, API key o `Bearer`/`Basic` con valor en un comentario. |
| `DOC_SENSITIVE_COMMENT` | HIGH | Email, URL de un host real o IP en un comentario. |
| `DOC_HEADER_NOT_FIRST` | LOW | La cabecera existe pero no está en la línea 1. |
| `DOC_MISSING_SUMMARY` / `DOC_SUMMARY_FORMAT` | LOW | Falta la frase de resumen o no termina en punto o pasa de 140 caracteres. |
| `DOC_MISSING_RUNTIME` | LOW | Falta `Paso Script:` o `Motor:`. |
| `DOC_MISSING_SECTION` | LOW | Falta `Entrada`, `Salida`, `Historial`, `Errores` (si hay `throw`) o `Parámetros` (XSLT con `xsl:param`). |
| `DOC_MISSING_VERSION` | LOW | Falta `@version X.Y.Z`. |
| `DOC_HISTORY_FORMAT` / `DOC_HISTORY_VERSION_MISMATCH` | LOW | Una entrada no sigue `X.Y.Z  AAAA-MM-DD  texto`, o la primera entrada no coincide con `@version`. |
| `DOC_MISSING_METHOD_DOC` / `DOC_PARAM_MISMATCH` | LOW | Un método auxiliar no tiene Groovydoc, o sus `@param` no coinciden con la firma. |
| `XSLT_DOC_PARAM_MISMATCH` | LOW | Hay un `xsl:param` que no aparece en `Parámetros:`. |
| `DOC_COMMENTED_OUT_CODE` / `XSLT_DOC_COMMENTED_OUT_CODE` | LOW | Código o marcado comentado. |
| `DOC_TODO_LEFT` | LOW | `TODO` o `FIXME` en comentarios fuera de la cabecera. |
| `DOC_BANNER_COMMENT` | LOW | Banner decorativo `// =====`. |
| `DOC_MARKDOWN_DOC_COMMENT` | LOW | Comentario `///`. |

Las reglas comparten la fórmula de score del pack (−30, −15, −5 y −2). La implementación está en `shared/doc-standard.mjs`.

**Siempre activas:** `DOC_SECRET_IN_COMMENT` y `DOC_SENSITIVE_COMMENT` (y sus equivalentes `XSLT_*`) se aplican **también sin `--docs`**: en `validate-groovy.mjs`, `audit-groovy.mjs`, el inspector de `.zip` y `validate-xslt.mjs`, donde cuentan como error. Son reglas de seguridad, no de estilo. El resto de reglas `DOC_*` solo se aplican con `--docs`, para no penalizar scripts heredados que se auditan por motivos técnicos.

---

## 9. Fuentes consultadas

- SAP Help Portal: *Integration Flow Design Guidelines*, incluidas *Keep Readability in Mind* y *Use Scripting Appropriately* — https://help.sap.com/docs/cloud-integration/sap-cloud-integration/integration-flow-design-guidelines
- SAP Help Portal: *Define a Local Script Step* (uso seguro de scripts) — https://help.sap.com/docs/r/368c481cd6954bdfa5d0435479fd4eaf/Cloud/en-US/03b32eb2c5c249f0a59bcd27c44d1e4e.html
- SAP Help Portal: *Naming Conventions* — https://help.sap.com/docs/cloud-integration/sap-cloud-integration/naming-conventions
- SAP Community: *SAP Cloud Integration – Upgrade Readiness Design Guidelines / Best Practices* — https://community.sap.com/t5/technology-blog-posts-by-sap/sap-cloud-integration-upgrade-readiness-design-guidelines-best-practices/ba-p/14285427
- SAP Community: *Comprehensive SAP CPI Guide for Standards & Best Practices* — https://community.sap.com/t5/technology-blog-posts-by-members/comprehensive-sap-cpi-guide-for-standards-best-practices/ba-p/13457873
- Apache Groovy: *Groovydoc* — https://docs.groovy-lang.org/docs/next/html/documentation/groovydoc.html
- Apache Groovy: *Style guide* — https://docs.groovy-lang.org/latest/html/documentation/style-guide.html
- CPILint (reglas de nomenclatura según las Design Guidelines de SAP) — https://github.com/mwittrock/cpilint

SAP no publica una plantilla oficial de cabecera para scripts. Esta cabecera combina las directrices anteriores con las convenciones de Groovydoc y Javadoc. Cuando SAP publique una guía oficial, adapta esta regla y `shared/doc-standard.mjs` a la vez.
