# Referencia de Línea de Comandos (CLI Reference)

Todos los scripts requieren **Node.js `>= 18.0.0`** y devuelven código de salida `0` en caso de éxito o `1` si se detectan errores de validación.

---

## 1. Utilidades Globales

### 1.1. `setup-skills.mjs` (Instalador Universal Multi-IDE + Servidor MCP Local)
Copia las 8 skills, `shared/`, `rules/` y `mcp-server.mjs`, y genera los archivos de reglas y configuración MCP para cada IDE o Agente IA.

```bash
node setup-skills.mjs [--target <directorio>] [--agent all|both|antigravity|claude|codex|cursor|copilot|windsurf|cline] [--mcp]
```

| Opción | Descripción |
| :--- | :--- |
| `--target <dir>` | Ruta del proyecto donde se instalarán las skills y reglas (por defecto: directorio actual). |
| `--agent <tipo>` | Ecosistema destino: `all` (todos los IDEs/IAs), `both` (`.agents` + `.claude`), `antigravity`, `claude`, `codex` (`AGENTS.md`), `cursor` (`.cursor/rules/*.mdc`), `copilot` (`.github/copilot-instructions.md`), `windsurf` (`.windsurf/rules/`) o `cline` (`.clinerules/`). |
| `--mcp` | Registra automáticamente el servidor MCP local (`node .agents/mcp-server.mjs`) en `.mcp.json`, `.cursor/mcp.json` y `.vscode/mcp.json`. |

### 1.1b. `mcp-server.mjs` (Servidor MCP Local `stdio` JSON-RPC 2.0)
Expone los 20 motores deterministas como herramientas MCP (`tools/list`, `tools/call`) y las 8 `SKILL.md` como recursos y prompts MCP (`resources/list`, `prompts/list`).

```bash
node mcp-server.mjs              # Modo servidor stdio (invocado automáticamente por el IDE)
node mcp-server.mjs --self-test  # Autoverificación de las 20 tools y 9 resources MCP
```

### 1.2. `verify-all.mjs` (Suite de Auto-Verificación)
Ejecuta pruebas integrales sobre los 16 módulos deterministas y el servidor MCP creando artefactos sintéticos en memoria/temporal y verificando su salida.

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
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs <archivo.zip | archivo.iflw> [--pdf <informe.pdf>] [--remediate <manifest,https,timeouts,streaming,csrf,groovy|all> --out <Corregido.zip>] [--extract-dir <carpeta>] [--show-prop-values] [--json]
```

- `<archivo.zip>`: Ruta al paquete iFlow, Script Collection o paquete compuesto exportado de SAP CPI.
- `--pdf <informe.pdf>`: Genera un archivo PDF nativo con el resumen ejecutivo, puntuación `0-100`, catálogo de recursos, tabla de hallazgos (incluyendo auditoría de scripts `.groovy` incluidos) y cambios propuestos.
- `--remediate <cambios> --out <Corregido.zip>`: Genera un nuevo paquete `.zip` aplicando únicamente los cambios confirmados por el usuario (`manifest`, `https`, `timeouts`, `streaming`, `csrf`, `groovy` o `all`). Si se combina con `--pdf`, genera el PDF sobre el paquete ya corregido.
- `--extract-dir <carpeta>`: Extrae físicamente todos los recursos internos del `.zip` en la carpeta indicada.
- `--show-prop-values`: Muestra los valores reales de los archivos `.prop` (por defecto se redactan como `[REDACTED]` por privacidad).
- `--json`: Devuelve el inventario de archivos, hallazgos de auditoría y `availableRemediations` en formato JSON.

---

### 2.1b. `diff-iflow-zip.mjs` (`sap-cpi-zip-inspector`)
Compara semánticamente dos paquetes `.zip` de SAP CPI (iFlows o Script Collections) eliminando el ruido BPMNDI y detectando cambios topológicos, parámetros externalizados modificados/añadidos, recursos del paquete OSGi y delta de puntuación de gobernanza (Score).

```bash
node skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs <v1.zip> <v2.zip> [--pdf <informe-diff.pdf>] [--show-prop-values] [--json]
node skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs --demo [--pdf <diff.pdf>] [--json]
```

- `<v1.zip>` y `<v2.zip>`: Paquetes base y objetivo a comparar.
- `--pdf <informe-diff.pdf>`: Genera un informe comparativo formal en PDF con tablas de recursos, checklist de parámetros y delta de cumplimiento.
- `--show-prop-values`: Muestra los valores reales de los parámetros (por defecto `[REDACTED]`).
- `--json`: Salida estructurada de cambios topológicos, archivos y parámetros.

---

### 2.2. `validate-groovy.mjs` (`sap-cpi-groovy-generator`)
Valida estáticamente uno o varios scripts Groovy de SAP CPI (archivo individual, carpeta de scripts o paquete `.zip` de una Script Collection) frente a las reglas de *Upgrade Readiness*, firma `processData`, protección anti-XXE, inmutabilidad `@Field final` y streaming.

```bash
# Modo 1: Validar script, carpeta o .zip
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script.groovy | carpeta | paquete.zip> [--strict] [--json]

# Modo 2: Generar plantilla canónica 100/100 para patrones de CPI
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs \
  --template <json-streaming|xml-slurper|mpl-custom-headers|oauth-token-inject|dynamic-routing-header|base64-attachment> \
  [--api v1|v2] [--json]
```

- `<script.groovy | carpeta | paquete.zip>`: Ruta a un archivo `.groovy`, a un directorio completo de scripts o a un `.zip` que contenga scripts Groovy.
- `--template <patrón>`: Emite código fuente Groovy production-ready (100/100) para el patrón arquitectónico indicado.
- `--api v1|v2`: Versión del API de CPI (`v1` para `com.sap.gateway.ip.core.customdev.util.Message` en Groovy 2.4 o `v2` para `com.sap.it.script.v2.api.Message` en Groovy 4).
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
# Modo 1: Inferir desde muestras JSON y validar el XSD resultante (--tolerant añade minOccurs="0" nillable="true", --no-ns omite targetNamespace)
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer <muestra1.json> [muestra2.json ...] \
  [--root <NombreElementoRaiz>] \
  [--ns <URI> | --no-ns] \
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

# Modo 5: Simular la ejecución de un Mapeo Gráfico (.mmap) con payload XML o JSON
node skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs \
  --mmap <Mapeo.mmap> \
  --payload <Entrada.xml|Entrada.json> \
  [--header SapSender=CRM --header CamelHttpMethod=POST] \
  [--prop SAP_MplCorrelationId=CORR-01] \
  [--out <Salida.xml>] \
  [--json]

# Demo del simulador
node skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs --demo [--json]
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
Genera `<IflowId>.zip`, `<ScriptCollectionId>.zip` y el paquete combinado `Paquete_<IflowId>.zip`. Soporta incluir tanto contenido en línea (`content` / `iflwXml`) como rutas a archivos ya generados en disco (`filePath` / `iflwPath`) para `groovyScripts`, `xsdSchemas`, `messageMappings`, `xsltMappings`, `wsdlFiles` y `embeddedScripts`.

```bash
node skills/sap-cpi-architect/scripts/build-cpi-package.mjs [--spec] <bundle-spec.json> --out-dir <carpeta-salida>
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
Extrae metadatos arquitectónicos de un `.zip`, valida que un documento Markdown contenga las 8 secciones técnicas obligatorias y permite exportar el Documento de Diseño Técnico formal en PDF de 8 secciones.

```bash
# Modo 1: Extraer información y opcionalmente exportar el PDF técnico oficial de 8 secciones
node skills/sap-cpi-architect/scripts/extract-for-docs.mjs <paquete.zip> [--pdf <DisenoTecnico.pdf>] [--json]

# Modo 2: Validar un documento Markdown de diseño técnico (8/8 secciones)
node skills/sap-cpi-architect/scripts/extract-for-docs.mjs --validate-doc <documento.md>
```

#### Generador de Clientes API Postman & OpenAPI (`export-api-client.mjs`)
Inspecciona los canales de entrada (`HTTPS`, `SOAP`, `OData`, `AS2`) de un iFlow `.zip`, extrae esquemas XSD y genera colecciones listas para pruebas en Postman v2.1 (con flujo de obtención CSRF) y contratos OpenAPI 3.0.3.

```bash
node skills/sap-cpi-architect/scripts/export-api-client.mjs <paquete.zip> [--format postman|openapi|both] [--out-dir <carpeta>] [--base-url <url>] [--json]
node skills/sap-cpi-architect/scripts/export-api-client.mjs --demo [--out-dir <carpeta>]
```

#### Constructor de Paquetes OSGi de Value Mapping (`build-value-mapping.mjs`)
Construye paquetes `.zip` de Value Mapping compatibles con SAP CPI a partir de especificaciones JSON o tablas CSV.

```bash
# Desde archivo CSV
node skills/sap-cpi-architect/scripts/build-value-mapping.mjs <tabla.csv> --name <VM_Name> [--out <VM_Name.zip>] [--json]

# Desde archivo JSON estructurado
node skills/sap-cpi-architect/scripts/build-value-mapping.mjs <tabla.json> [--name <VM_Name>] [--out <VM_Name.zip>] [--json]

# Demo
node skills/sap-cpi-architect/scripts/build-value-mapping.mjs --demo [--out <VM_Demo.zip>]
```

---

## 3. Catálogo de Herramientas MCP (20 Tools Nativas)

Cuando el servidor `mcp-server.mjs` está activo (arrancado por el IDE o cliente MCP vía stdio), se exponen las siguientes herramientas:

| Herramienta MCP | Módulo / Skill | Descripción |
| :--- | :--- | :--- |
| `cpi_inspect_zip` | `sap-cpi-zip-inspector` | Audita paquetes `.zip`/`.iflw`, calcula puntuación 0-100, genera inventario e informe PDF opcional. |
| `cpi_remediate_zip` | `sap-cpi-zip-inspector` | Aplica correcciones automáticas (`manifest`, `https`, `timeouts`, `streaming`, `csrf`, `groovy`, `all`) y emite nuevo `.zip`. |
| `cpi_diff_bundles` | `sap-cpi-zip-inspector` | Compara semánticamente dos paquetes iFlow/SC, reporta diferencias topológicas y de parámetros, y exporta PDF comparativo. |
| `cpi_validate_groovy` | `sap-cpi-groovy-generator` | Valida código Groovy (o archivo en disco) frente a reglas de Upgrade Readiness, imports y anti-XXE. |
| `cpi_audit_groovy` | `sap-cpi-code-auditor` | Audita código Groovy original y lo compara contra versión refactorizada exigiendo 100/100. |
| `cpi_generate_groovy_template` | `sap-cpi-groovy-generator` | Emite código Groovy 2.4 / 4 con puntuación garantizada 100/100 para los 6 patrones canónicos de CPI. |
| `cpi_infer_xsd` | `sap-cpi-xsd-studio` | Infiere y valida un esquema W3C XSD 1.0 combinando múltiples muestras JSON. |
| `cpi_validate_xsd` | `sap-cpi-xsd-studio` | Valida un esquema XSD 1.0 frente a reglas de compatibilidad de SAP CPI Message Mapping. |
| `cpi_build_mmap` | `sap-cpi-xsd-studio` | Genera y valida un archivo de Mapeo Gráfico `.mmap` (`<xiObj>`) sintetizando contenedores padre. |
| `cpi_simulate_mmap` | `sap-cpi-xsd-studio` | Simula la ejecución local de un mapeo `.mmap` con payload XML o JSON, cabeceras y propiedades Exchange. |
| `cpi_validate_xslt` | `sap-cpi-xslt-studio` | Valida hojas de estilo XSLT 1.0 (Xalan) o 2.0/3.0 (Saxon-HE) y funciones del Exchange CPI. |
| `cpi_test_regex` | `sap-cpi-regex-studio` | Evalúa expresiones regulares contra ReDoS y genera expresiones Apache Camel Simple. |
| `cpi_pack_mock_suite` | `sap-cpi-mock-data-generator` | Valida contratos y correlaciones de foreign keys entre múltiples payloads y empaqueta suite de prueba en `.zip`. |
| `cpi_build_package` | `sap-cpi-architect` | Construye paquetes OSGi `.zip` (iFlow + Script Collection) con MANIFEST.MF en raíz plegado a 72 bytes. |
| `cpi_clone_bundle` | `sap-cpi-architect` | Clona y adapta iFlows existentes, inyecta recursos o actualiza Script Collections. |
| `cpi_get_iflow_endpoints` | `sap-cpi-architect` | Extrae matriz concisa de conectividad de un iFlow (inbound, outbound, URLs, protocolos, CSRF y timeouts). |
| `cpi_extract_bundle_file` | `shared/zip-utils` | Extrae e inspecciona en memoria el texto de un archivo específico dentro de un paquete `.zip` sin tocar disco. |
| `cpi_export_technical_doc` | `sap-cpi-architect` | Genera el Documento de Diseño Técnico oficial de 8 secciones en PDF y/o Markdown. |
| `cpi_export_api_client` | `sap-cpi-architect` | Genera colecciones de pruebas Postman v2.1 (con flujo CSRF) y contratos OpenAPI 3.0. |
| `cpi_build_value_mapping` | `sap-cpi-architect` | Construye paquetes OSGi `.zip` de Value Mapping a partir de JSON o tablas CSV. |
