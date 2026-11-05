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
Descomprime en memoria un paquete `.zip` de SAP CPI (`IntegrationFlow`, `ScriptCollection` o paquetes compuestos con `.zip` anidados), clasifica sus archivos internos (`.iflw`, `.groovy`, `.xslt`, `.mmap`, `.xsd`, `.prop`), redacta por defecto los valores de `.prop` (`[REDACTED]`), ejecuta la auditoría determinista sobre el modelo BPMN 2.0 (`.iflw`) y permite exportar un **informe ejecutivo en PDF** o generar un **nuevo `.zip` corregido** aplicando únicamente las remediaciones seleccionadas por el usuario.

```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs <archivo.zip | archivo.iflw> [--pdf <informe.pdf>] [--remediate <manifest,https,timeouts,streaming,csrf|all> --out <Corregido.zip>] [--extract-dir <carpeta>] [--show-prop-values] [--json]
```

- `<archivo.zip>`: Ruta al paquete iFlow, Script Collection o paquete compuesto exportado de SAP CPI.
- `--pdf <informe.pdf>`: Genera un archivo PDF nativo con el resumen ejecutivo, puntuación `0-100`, catálogo de recursos, tabla de hallazgos y cambios propuestos.
- `--remediate <cambios> --out <Corregido.zip>`: Genera un nuevo paquete `.zip` aplicando únicamente los cambios confirmados por el usuario (`manifest`, `https`, `timeouts`, `streaming`, `csrf` o `all`).
- `--extract-dir <carpeta>`: Extrae físicamente todos los recursos internos del `.zip` en la carpeta indicada.
- `--show-prop-values`: Muestra los valores reales de los archivos `.prop` (por defecto se redactan como `[REDACTED]` por privacidad).
- `--json`: Devuelve el inventario de archivos, hallazgos de auditoría y `availableRemediations` en formato JSON.

---

### 2.2. `validate-groovy.mjs` (`sap-cpi-groovy-generator`)
Valida estáticamente uno o varios scripts Groovy de SAP CPI (archivo individual, carpeta de scripts o paquete `.zip` de una Script Collection) frente a las reglas de *Upgrade Readiness*, firma `processData`, protección anti-XXE, inmutabilidad `@Field final` y streaming.

```bash
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script.groovy | carpeta | paquete.zip> [--strict] [--json]
```

- `<script.groovy | carpeta | paquete.zip>`: Ruta a un archivo `.groovy`, a un directorio completo de scripts o a un `.zip` que contenga scripts Groovy.
- `--strict`: Exige puntuación perfecta de `100/100` en todos los scripts analizados.
- `--json`: Devuelve el resultado individual o en lote en formato JSON.

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

### 2.6. `validate-xsd.mjs` y `build-mmap.mjs` (`sap-cpi-xsd-studio`)
Permiten inferir y validar esquemas W3C XSD 1.0 y generar/validar mapeos gráficos `.mmap` (`<xiObj>`) para SAP CPI Message Mapping.

```bash
# Modo 1: Inferir desde muestras JSON y validar el XSD resultante (--tolerant añade minOccurs="0" nillable="true")
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer <muestra1.json> [muestra2.json ...] \
  [--root <NombreElementoRaiz>] \
  [--ns <URI>] \
  [--tolerant] \
  [--out <salida.xsd>] \
  [--json]

# Modo 2: Validar un archivo XSD existente
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs <esquema.xsd> [--json]

# Modo 3: Generar un Graphical Message Mapping (.mmap / <xiObj>)
node skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs \
  --source-xsd <Origen.xsd:RootOrigen> \
  --target-xsd <Destino.xsd:RootDestino> \
  [--map /RootDestino/a=/RootOrigen/b] \
  [--const /RootDestino/c=VALOR] \
  [--header /RootDestino/h=CamelHttpMethod] \
  [--property /RootDestino/p=SAP_MplCorrelationId] \
  --out <Mapeo.mmap>

# Modo 4: Validar un archivo .mmap existente
node skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs --validate <Mapeo.mmap> [--json]
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

### 2.8. `build-cpi-package.mjs`, `clone-iflow-bundle.mjs` y `extract-for-docs.mjs` (`sap-cpi-architect`)

#### Constructor de Paquetes OSGi (`build-cpi-package.mjs`)
Genera `<IflowId>.zip`, `<ScriptCollectionId>.zip` y el paquete combinado `Paquete_<IflowId>.zip`.

```bash
node skills/sap-cpi-architect/scripts/build-cpi-package.mjs <bundle-spec.json> --out-dir <carpeta-salida>
```

#### Clonador y Adaptador de Bundles de Referencia (`clone-iflow-bundle.mjs`)
Permite clonar un iFlow existente (`.zip`) renombrando sus descriptores OSGi (`.project`, `MANIFEST.MF`, `metainfo.prop`, `<NuevoNombre>.iflw`), reemplazando referencias a scripts `.groovy` y rutas XPath del Splitter sin alterar ni exponer los archivos privados `.prop`. También permite actualizar un paquete `ScriptCollection.zip` inyectando nuevos scripts validados.

```bash
# Clonar y adaptar un iFlow de referencia (o inyectar recursos sueltos con --add-resource)
node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
  --source <Referencia_iFlow.zip> \
  [--target-name <Nuevo_iFlow>] \
  --out <Nuevo_iFlow.zip> \
  [--replace <ScriptOrigen.groovy=ScriptDestino.groovy>] \
  [--xpath <//nodoOrigen=//nodoDestino>] \
  [--add-resource <Esquema.xsd|Mapeo.mmap|Transform.xsl|Script.groovy>]

# Actualizar una Script Collection con nuevos scripts Groovy validados
node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
  --update-sc <SC_Origen.zip> \
  --scripts-dir <carpeta-scripts> \
  --out <SC_Actualizada.zip> \
  [--strict]
```

#### Extractor y Validador de Documentación Técnica (`extract-for-docs.mjs`)
Extrae metadatos arquitectónicos de un `.zip` y valida que un documento Markdown contenga las 8 secciones técnicas obligatorias.

```bash
node skills/sap-cpi-architect/scripts/extract-for-docs.mjs <paquete.zip> [--validate-doc <documento.md>] [--json]
```
