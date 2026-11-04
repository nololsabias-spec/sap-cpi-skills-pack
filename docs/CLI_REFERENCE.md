# Referencia de Línea de Comandos (CLI Reference)

Todos los scripts requieren **Node.js `>= 18.0.0`** y devuelven código de salida `0` en caso de éxito o `1` si se detectan errores de validación.

---

## 1. Utilidades Globales

### 1.1. `setup-skills.mjs` (Instalador de Skills)
Copia las 8 skills y la librería `shared/zip-utils.mjs` a las carpetas `.agents/skills` y `.claude/skills` del directorio destino.

```bash
node setup-skills.mjs [--target <directorio>] [--agents-only] [--claude-only]
```

| Opción | Descripción |
| :--- | :--- |
| `--target <dir>` | Ruta del proyecto donde se instalarán las skills (por defecto: directorio actual). |
| `--agents-only` | Instala únicamente en `<target>/.agents/skills`. |
| `--claude-only` | Instala únicamente en `<target>/.claude/skills`. |

### 1.2. `verify-all.mjs` (Suite de Auto-Verificación)
Ejecuta pruebas integrales sobre los 8 motores CLI creando artefactos sintéticos en memoria/temporal y verificando su salida.

```bash
node verify-all.mjs
# o mediante npm:
npm test
```

---

## 2. Scripts por Módulo

### 2.1. `inspect-iflow-zip.mjs` (`sap-cpi-zip-inspector`)
Descomprime en memoria un paquete `.zip` de SAP CPI (incluso paquetes anidados), clasifica sus archivos internos y ejecuta la auditoría de 5 puntos sobre el modelo BPMN 2.0 (`.iflw`).

```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs <archivo.zip> [--extract-to <carpeta>] [--json]
```

- `<archivo.zip>`: Ruta al paquete iFlow o paquete dual exportado de SAP CPI.
- `--extract-to <carpeta>`: Extrae físicamente todos los recursos internos del `.zip` en la carpeta indicada.
- `--json`: Devuelve el inventario de archivos y los hallazgos de auditoría en formato JSON.

---

### 2.2. `validate-groovy.mjs` (`sap-cpi-groovy-generator`)
Valida estáticamente un script Groovy de SAP CPI frente a las reglas base (*Upgrade Readiness*, firma `processData`, protección anti-XXE) y las directivas seleccionadas.

```bash
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script.groovy> [--directives=d1,d2,...] [--strict] [--json]
```

- `<script.groovy>`: Ruta al archivo `.groovy` a validar.
- `--directives=<lista>`: Lista separada por comas de las directivas activas:
  - `jsonSlurper`, `streaming`, `xmlParser`, `mpl`, `secureStore`, `valueMapping`, `utcDates`, `headers`, `sql`, `throwEx`.
- `--strict`: Hace que las advertencias (`WARN`) también provoquen código de salida `1`.
- `--json`: Devuelve el resultado (`valid`, `score`, `findings`, `metrics`) en JSON.

---

### 2.3. `audit-groovy.mjs` (`sap-cpi-code-auditor`)
Audita la calidad, seguridad y consumo de memoria de un script Groovy calculando su puntuación (`0-100`). Permite además verificar una refactorización comparando el script original con el refactorizado.

```bash
node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs <original.groovy> [--refactored <refactorizado.groovy>] [--json]
```

- `<original.groovy>`: Script original a auditar.
- `--refactored <archivo.groovy>`: (Opcional) Script refactorizado. Si se proporciona, el comando verifica que el script refactorizado alcance una puntuación de `100/100` con `0` hallazgos críticos o altos.
- `--json`: Salida estructurada en JSON.

---

### 2.4. `validate-xslt.mjs` (`sap-cpi-xslt-studio`)
Valida hojas de transformación XSLT para SAP CPI según el motor objetivo (`1.0` Xalan o `2.0`/`3.0` Saxon-HE) y el escenario de integración.

```bash
node skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs <transformacion.xslt> [--version=1.0|2.0|3.0] [--scenario=standard|grouping|flatten|headers] [--json]
```

- `<transformacion.xslt>`: Ruta al archivo `.xslt` o `.xsl`.
- `--version`: Versión del motor XSLT (`1.0`, `2.0` o `3.0`).
- `--scenario`: Escenario esperado:
  - `standard`: Mapeo estándar.
  - `grouping`: Agrupación (`xsl:for-each-group` en 2.0+ o Muenchian Grouping en 1.0).
  - `flatten`: Aplanamiento jerárquico.
  - `headers`: Interacción con el Exchange de SAP CPI (`cpi:setHeader` / `cpi:setProperty`).

---

### 2.5. `test-camel-regex.mjs` (`sap-cpi-regex-studio`)
Analiza una expresión regular para detectar riesgos de *Catastrophic Backtracking (ReDoS)*, genera las expresiones Apache Camel Simple y ejecuta pruebas de coincidencia y reemplazo.

```bash
node skills/sap-cpi-regex-studio/scripts/test-camel-regex.mjs \
  --pattern "<regex>" \
  [--flags "<flags>"] \
  [--prop "<nombrePropiedad>"] \
  [--replacement "<plantillaReemplazo>"] \
  [--match "caso1,caso2"] \
  [--no-match "caso3,caso4"] \
  [--spec <archivo.json>] \
  [--json]
```

- `--pattern`: Expresión regular (debe incluir anclaje `^...$`).
- `--prop`: Nombre de la propiedad en SAP CPI para generar las expresiones `${property.<prop>} regex '...'` y `.replaceAll(...)`.
- `--replacement`: Plantilla de reemplazo usando grupos `$1`, `$2`, etc.
- `--match` / `--no-match`: Listas separadas por comas de cadenas que deben coincidir o no coincidir.
- `--spec <archivo.json>`: Alternativa para pasar los casos de prueba desde un archivo JSON.

---

### 2.6. `validate-xsd.mjs` (`sap-cpi-xsd-studio`)
Permite inferir un esquema W3C XSD 1.0 a partir de múltiples muestras JSON y/o validar un archivo `.xsd` existente para Message Mapping en SAP CPI.

```bash
# Modo 1: Inferir desde muestras JSON y validar el XSD resultante
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer <muestra1.json> [muestra2.json ...] \
  [--root <NombreElementoRaiz>] \
  [--namespace <URI>] \
  [--out <salida.xsd>] \
  [--json]

# Modo 2: Validar un archivo XSD existente
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs <esquema.xsd> [--json]
```

---

### 2.7. `pack-mock-suite.mjs` (`sap-cpi-mock-data-generator`)
Valida la sintaxis XML/JSON de múltiples payloads de prueba, comprueba que compartan los mismos valores en sus campos de correlación de negocio y empaqueta la suite en un archivo `.zip`.

```bash
node skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs --spec <suite-spec.json> [--out <MockSuite.zip>] [--json]
```

Estructura de `<suite-spec.json>`:
```json
{
  "correlationKeys": ["orderId", "customerId"],
  "contracts": [
    {
      "name": "OrderRequest",
      "format": "json",
      "examples": [
        { "type": "ok", "filename": "order_ok_1.json", "content": "{\"orderId\":\"ORD-100\",\"customerId\":\"CUST-01\"}" },
        { "type": "error", "filename": "order_err_1.json", "content": "{\"orderId\":\"ORD-100\"}" }
      ]
    }
  ]
}
```

---

### 2.8. `build-cpi-package.mjs` y `extract-for-docs.mjs` (`sap-cpi-architect`)

#### Constructor de Paquetes OSGi (`build-cpi-package.mjs`)
Genera `<IflowId>.zip`, `<ScriptCollectionId>.zip` y el paquete combinado `Paquete_<IflowId>.zip`.

```bash
node skills/sap-cpi-architect/scripts/build-cpi-package.mjs --spec <bundle-spec.json> --out-dir <carpeta-salida>
```

#### Extractor y Validador de Documentación Técnica (`extract-for-docs.mjs`)
Extrae metadatos arquitectónicos de un `.zip` y valida que un documento Markdown contenga las 8 secciones técnicas obligatorias.

```bash
node skills/sap-cpi-architect/scripts/extract-for-docs.mjs <paquete.zip> [--validate-doc <documento.md>] [--json]
```
