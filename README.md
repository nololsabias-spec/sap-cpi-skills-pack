# SAP CPI Skills & Deterministic Validation Pack (`sap-cpi-skills-pack`)

Suite modular de **8 Skills especializadas para Agentes IA** y **herramientas CLI de validación estática, auditoría de arquitectura, inferencia de esquemas y empaquetado OSGi (`.zip`)** para **SAP Cloud Integration (SAP Integration Suite / CPI)**.

Construido íntegramente con módulos nativos de **Node.js (`v18+`) sin dependencias externas** (`node:fs`, `node:zlib`, `node:path`), permitiendo ejecutar validaciones deterministas, auditorías de código y generación de paquetes importables en SAP CPI tanto a través de asistentes de IA (**Antigravity**, **Claude Code**, **Cursor**) como desde la terminal o pipelines CI/CD.

---

## Tabla de Contenidos

1. [Requisitos Previos](#1-requisitos-previos)
2. [Instalación y Configuración Rápida](#2-instalación-y-configuración-rápida)
3. [Estructura del Proyecto](#3-estructura-del-proyecto)
4. [Catálogo de las 8 Skills y Motores CLI](#4-catálogo-de-las-8-skills-y-motores-cli)
5. [Guía de Uso por Módulo (CLI y Agentes IA)](#5-guía-de-uso-por-módulo-cli-y-agentes-ia)
6. [Documentación Técnica Detallada](#6-documentación-técnica-detallada)

---

## 1. Requisitos Previos

- **Node.js `>= 18.0.0`** (no requiere `npm install` ni paquetes de terceros).
- Compatible con Windows, macOS y Linux.

---

## 2. Instalación y Configuración Rápida

### Clonar y verificar el entorno

```bash
git clone https://github.com/nololsabias-spec/sap-cpi-skills-pack.git
cd sap-cpi-skills-pack

# Ejecutar la suite de auto-verificación (valida los 8 módulos)
npm test
```

### Instalar las Skills y el Servidor MCP Local en tu IDE / Agente IA

El script [`setup-skills.mjs`](./setup-skills.mjs) instala las 8 skills, las utilidades compartidas (`shared/`), el harness de aprendizaje continuo y el **servidor MCP local (`mcp-server.mjs`)** para todos los asistentes e IDEs de desarrollo con IA:

```bash
# Instalar para TODOS los IDEs y Agentes IA a la vez (Antigravity, Claude, OpenAI Codex/GPT, Cursor, GitHub Copilot, Windsurf, Cline + Servidor MCP local)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent all --mcp

# O instalar para un asistente o IDE específico:
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent antigravity  # Google Antigravity (.agents/)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent claude --mcp # Claude Code / Desktop (.claude/ + .mcp.json)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent codex        # OpenAI Codex CLI / GPT Agents (AGENTS.md + .agents/)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent cursor       # Cursor IDE (.cursor/rules/*.mdc + .cursor/mcp.json)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent copilot      # GitHub Copilot VS Code (.github/copilot-instructions.md + .vscode/mcp.json)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent windsurf     # Windsurf IDE (.windsurf/rules/sap-cpi.md)
node setup-skills.mjs --target /ruta/a/tu/proyecto --agent cline        # Cline / Roo Code (.clinerules/sap-cpi.md)
```

### Servidor MCP Local (`mcp-server.mjs` — Cero Dependencias, 100% Local `stdio`)

El proyecto incluye [`mcp-server.mjs`](./mcp-server.mjs), un servidor **Model Context Protocol (MCP)** sobre `stdin`/`stdout` (JSON-RPC 2.0) que el IDE arranca automáticamente en segundo plano al abrir la carpeta (gracias a `.vscode/mcp.json`, `.cursor/mcp.json` o `.mcp.json`), exponiendo **16 Tools nativas** (`cpi_inspect_zip`, `cpi_remediate_zip`, `cpi_diff_bundles`, `cpi_validate_groovy`, `cpi_audit_groovy`, `cpi_infer_xsd`, `cpi_validate_xsd`, `cpi_build_mmap`, `cpi_simulate_mmap`, `cpi_validate_xslt`, `cpi_test_regex`, `cpi_build_package`, `cpi_clone_bundle`, `cpi_export_technical_doc`, `cpi_export_api_client`, `cpi_build_value_mapping`) y las **8 Skills como Resources/Prompts MCP** sin necesidad de pedir permisos de consola en cada validación:

```bash
# Verificar el servidor MCP local
node mcp-server.mjs --self-test
```

---

## 3. Estructura del Proyecto

```text
sap-cpi-skills-pack/
├── README.md                           # Guía principal de instalación y uso
├── AGENTS.md / CLAUDE.md               # Harness de ingeniería y aprendizaje continuo (Codex / Antigravity / Claude)
├── mcp-server.mjs                      # Servidor MCP local (stdio JSON-RPC 2.0, 16 tools + 9 resources)
├── package.json                        # Scripts de verificación (npm test), MCP y demostraciones
├── setup-skills.mjs                    # Instalador universal Multi-IDE (Antigravity, Claude, Codex, Cursor, Copilot, Windsurf, Cline)
├── verify-all.mjs                      # Suite de pruebas integrales de las 8 skills (15 módulos) + servidor MCP
├── rules/
│   └── sap-cpi-continuous-learning.md  # Regla de auto-evolución continua y privacidad estricta
├── shared/
│   ├── zip-utils.mjs                   # Motor ZIP nativo (lectura/escritura DEFLATE, CRC32 y normalización OSGi)
│   └── pdf-utils.mjs                   # Motor PDF 1.4 nativo (informes ejecutivos de auditoría multipágina)
├── docs/
│   ├── ARCHITECTURE.md                 # Arquitectura interna, modo dual Skills + MCP, motor ZIP y PDF
│   ├── CLI_REFERENCE.md                # Referencia completa de comandos, argumentos, flags y herramientas MCP
│   ├── VALIDATION_RULES.md             # Reglas de validación SAP CPI, scoring y seguridad
│   ├── WORKFLOWS_GUIDE.md              # Flujos de trabajo prácticos paso a paso
│   └── LESSONS_LEARNED.md              # Base de conocimiento viva con lecciones reales de SAP CPI anonimizadas
└── skills/
    ├── sap-cpi-zip-inspector/          # 1. Inspector .zip, auditor BPMN2, differ semántico, PDF y remediador
    │   └── scripts/                    #    (inspect-iflow-zip.mjs, diff-iflow-zip.mjs)
    ├── sap-cpi-groovy-generator/       # 2. Generador Groovy 2.4 / 4 y linter estático (validate-groovy.mjs)
    ├── sap-cpi-code-auditor/           # 3. Auditor de calidad/seguridad Groovy (Score 0-100, audit-groovy.mjs)
    ├── sap-cpi-xslt-studio/            # 4. Validador y generador XSLT 1.0/2.0/3.0 (validate-xslt.mjs)
    ├── sap-cpi-regex-studio/           # 5. Sandbox Regex + Apache Camel Simple (test-camel-regex.mjs)
    ├── sap-cpi-xsd-studio/             # 6. Inferencia XSD 1.0, mapeos gráficos .mmap y simulador de ejecución
    │   └── scripts/                    #    (validate-xsd.mjs, build-mmap.mjs, simulate-mmap.mjs)
    ├── sap-cpi-mock-data-generator/    # 7. Validador de correlación E2E y empaquetador (pack-mock-suite.mjs)
    └── sap-cpi-architect/              # 8. Constructor OSGi dual, doc técnica PDF, clientes Postman/OpenAPI y VM
        └── scripts/                    #    (build-cpi-package.mjs, clone-iflow-bundle.mjs, extract-for-docs.mjs,
                                        #     export-api-client.mjs, build-value-mapping.mjs)
```

---

## 4. Catálogo de las 8 Skills y Motores CLI

| # | Skill | Funcionalidad Principal | Script CLI |
| :- | :--- | :--- | :--- |
| **1** | `sap-cpi-zip-inspector` | Descomprime artefactos `.zip` (`IntegrationFlow`, `ScriptCollection` o paquetes anidados), redacta `.prop` por privacidad, inventaría recursos, audita riesgos BPMN 2.0 y CPILint, genera informes PDF ejecutivos y **compara semánticamente dos versiones de paquetes iFlow** eliminando el ruido BPMNDI. | `inspect-iflow-zip.mjs`<br>`diff-iflow-zip.mjs` |
| **2** | `sap-cpi-groovy-generator` | Genera y valida scripts Groovy (Script v1 y Groovy 4 v2 API) individualmente o en lote (carpetas/`.zip`), aplicando prevención de OOM, anti-XXE, `@Field final` y *Ensure Upgrade Readiness*. | `validate-groovy.mjs` |
| **3** | `sap-cpi-code-auditor` | Audita scripts Groovy calculando una puntuación determinista (`0-100`), desglosa vulnerabilidades por severidad y verifica refactorizaciones. | `audit-groovy.mjs` |
| **4** | `sap-cpi-xslt-studio` | Genera y valida transformaciones XSLT 1.0 (Xalan) y XSLT 2.0/3.0 (Saxon-HE), incluyendo `json-to-xml()`, `<xsl:param>` e interacción con cabeceras/propiedades del Exchange (`cpi:*` / `sapci:*`). | `validate-xslt.mjs` |
| **5** | `sap-cpi-regex-studio` | Diseña y prueba expresiones regulares con anclaje `^...$`, detector estático de *Catastrophic Backtracking (ReDoS)* y expresiones Apache Camel Simple (`date-with-timezone`, listas `not in`). | `test-camel-regex.mjs` |
| **6** | `sap-cpi-xsd-studio` | Infiere esquemas W3C XSD 1.0 a partir de muestras JSON, genera mapeos gráficos **`.mmap` (`<xiObj>`)** sintetizando contenedores padre y **simula localmente la ejecución del mapeo** con payloads XML/JSON reales. | `validate-xsd.mjs`<br>`build-mmap.mjs`<br>`simulate-mmap.mjs` |
| **7** | `sap-cpi-mock-data-generator` | Valida sintaxis XML/JSON (incluyendo estándares IDoc `EDI_DC40` y OData `$batch`), comprueba la correlación E2E entre múltiples contratos y empaqueta suites `.zip`. | `pack-mock-suite.mjs` |
| **8** | `sap-cpi-architect` | **Modo 1:** Construye paquetes OSGi `.zip` duales (iFlow + Script Collection). **Modo 2:** Extrae topología y genera **Documento Técnico formal de 8 secciones en PDF y Markdown**. **Modo 3:** Clona y adapta bundles `.zip` de referencia. **Modo 4:** Exporta **colecciones Postman v2.1 y OpenAPI 3.0** con CSRF handshake. **Modo 5:** Construye paquetes OSGi de **Value Mapping**. | `build-cpi-package.mjs`<br>`clone-iflow-bundle.mjs`<br>`extract-for-docs.mjs`<br>`export-api-client.mjs`<br>`build-value-mapping.mjs` |

---

## 5. Guía de Uso por Módulo (CLI y Agentes IA)

### 5.1. Inspector y Auditor de Paquetes iFlow (`sap-cpi-zip-inspector`)

Analiza un paquete `.zip` exportado de SAP CPI (`IntegrationFlow`, `ScriptCollection` o paquetes compuestos con `.zip` anidados), redacta automáticamente los valores sensibles de `.prop` como `[REDACTED]` y detecta ausencia de `Exception Subprocess`, llamadas `http://` sin TLS, credenciales o URLs sin `{{param}}`, `ExternalCall` sin timeout, copias de `${body}` en propiedades, Splitters sin streaming y reglas CPILint (`CleartextBasicAuth`, `CsrfProtectionRequired`):

```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --pdf ./Informe_Auditoria.pdf
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --remediate manifest,https,timeouts --out ./Paquete_Corregido.zip
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --json
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --extract-dir ./inspeccion

# Comparar semánticamente dos versiones de un paquete (iFlow o Script Collection) con reporte PDF
node skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs ./iFlow_v1.zip ./iFlow_v2.zip --pdf ./Comparativa.pdf
```

### 5.2. Validador y Linter de Scripts Groovy (`sap-cpi-groovy-generator`)

Verifica el cumplimiento de la firma oficial SAP CPI (`com.sap.gateway.ip.core.customdev.util.Message` v1 o `com.sap.it.script.v2.api.Message` v2 en Groovy 4), `Ensure Upgrade Readiness` (cero wildcards `.*`, cero imports sin usar, bloqueo de frameworks restringidos como Camel interno, OSGi, Spring, HikariCP, Groovy SQL, Quartz o Saxon), inmutabilidad `@Field final`, prevención de `GroovyShell` Metaspace OOM y protección anti-XXE. Soporta validar un script individual, una carpeta completa o un `.zip`:

```bash
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs ./script.groovy --strict
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs ./carpeta_scripts --strict
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs ./SC_Collection.zip --strict
```

### 5.3. Auditor de Calidad y Refactorización Groovy (`sap-cpi-code-auditor`)

Calcula el `Score de Calidad Original (0-100)` aplicando penalizaciones estáticas (`CRÍTICA: -30`, `ALTA: -15`, `MEDIA: -5`, `BAJA: -2`) y permite comparar un script original frente a su versión refactorizada:

```bash
# Auditar un script existente
node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./legacy.groovy

# Comparar el script original con el script refactorizado (exige 100/100 en el refactorizado)
node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./legacy.groovy --refactored ./refactored.groovy
```

### 5.4. Validador de Transformaciones XSLT (`sap-cpi-xslt-studio`)

Valida hojas de estilo XSLT para motores Xalan (1.0) o Saxon-HE (2.0/3.0), detectando llaves `{campo}` fuera de atributos, uso indebido de `#all` en XSLT 1.0 y configuración de funciones de extensión SAP CPI:

```bash
node skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs ./mapping.xslt --version=2.0 --scenario=headers
```

### 5.5. Sandbox de Expresiones Regulares y Camel Simple (`sap-cpi-regex-studio`)

Evalúa una expresión regular frente a casos de prueba positivos y negativos, detecta patrones vulnerables a ReDoS y genera expresiones listas para Router y Content Modifier:

```bash
node skills/sap-cpi-regex-studio/scripts/test-camel-regex.mjs \
  --pattern "^INV-([0-9]{4})-([A-Z]{2})$" \
  --prop "invoiceCode" \
  --replacement '$1/$2' \
  --match "INV-2026-ES,INV-9999-DE" \
  --no-match "INV-26-ES,ABC-2026-ES"
```

### 5.6. Inferencia XSD 1.0 y Mapeos Gráficos `.mmap` (`sap-cpi-xsd-studio`)

Infiere esquemas W3C XSD 1.0 a partir de una o varias muestras JSON (`--tolerant` para añadir `minOccurs="0" nillable="true"` y `--no-ns` para esquemas sin namespace), valida XSDs y genera/valida mapeos gráficos **`.mmap` (`<xiObj>`)** con síntesis automática de bricks contenedores padre:

```bash
# Inferir un XSD combinando múltiples muestras JSON y validarlo
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer ./muestra1.json ./muestra2.json \
  --root OrderRequest \
  --ns "http://sap.com/xi/Orders" \
  [--tolerant] \
  --out ./OrderRequest.xsd

# Generar un Graphical Message Mapping (.mmap / <xiObj>)
node skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs \
  --source-xsd OrderRequest.xsd:OrderRequest \
  --target-xsd S4Order.xsd:S4SalesOrder \
  --map "/S4SalesOrder/Header/SalesOrderID=/OrderRequest/orderId" \
  --const "/S4SalesOrder/Header/SourceSystem=SAP-CPI" \
  --header "/S4SalesOrder/Header/HttpMethod=CamelHttpMethod" \
  --property "/S4SalesOrder/Header/CorrelationId=SAP_MplCorrelationId" \
  --out ./MM_Order_To_S4.mmap

# Simular localmente la ejecución de un .mmap con payload XML o JSON
node skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs \
  --mmap ./MM_Order_To_S4.mmap \
  --payload ./input.xml \
  --header CamelHttpMethod=POST \
  --out ./output.xml
```

### 5.7. Empaquetador de Baterías de Prueba E2E (`sap-cpi-mock-data-generator`)

Valida sintaxis XML/JSON, verifica que los identificadores de negocio (`orderId`, `customerId`, `kunnr`, etc.) estén correlacionados entre múltiples contratos y genera un paquete `.zip` estructurado por escenarios (`ok/`, `edge/`, `error/`):

```bash
node skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs --spec ./suite-spec.json --out ./MockSuite.zip
```

### 5.8. Arquitecto SAP CPI: Empaquetado OSGi, Clonación, Documentación y Clientes API (`sap-cpi-architect`)

- **Modo 1 (`build-cpi-package.mjs`):** Construye los paquetes `.zip` con estructura OSGi (`META-INF/MANIFEST.MF`, `.project`, `.iflw`, `parameters.prop` y `Script Collection` independiente vinculada por `Provide-Capability` / `Require-Capability`):
  ```bash
  node skills/sap-cpi-architect/scripts/build-cpi-package.mjs ./bundle-spec.json --out-dir ./dist
  ```
- **Modo 2 (`extract-for-docs.mjs`):** Extrae la topología completa de un paquete `.zip`, valida las 8 secciones corporativas y genera el **Documento de Diseño Técnico formal en PDF y Markdown**:
  ```bash
  node skills/sap-cpi-architect/scripts/extract-for-docs.mjs ./Paquete_iFlow.zip --pdf ./Diseno_Tecnico.pdf
  node skills/sap-cpi-architect/scripts/extract-for-docs.mjs ./Paquete_iFlow.zip --validate-doc ./Documentacion_Tecnica.md
  ```
- **Modo 3 (`clone-iflow-bundle.mjs`):** Clona un iFlow `.zip` de referencia adaptando su identificador OSGi, scripts `.groovy` invocados y rutas XPath del Splitter (manteniendo intactos sus diagramas BPMN2 y archivos `.prop`), inyecta archivos sueltos (`.xsd`, `.mmap`, `.xsl`, `.groovy`, `.wsdl`) con `--add-resource`, o actualiza una `ScriptCollection.zip`:
  ```bash
  node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
    --source ./Referencia_iFlow.zip \
    --target-name Nuevo_iFlow_v1 \
    --out ./dist/Nuevo_iFlow_v1.zip \
    --replace ScriptOrigen.groovy=ScriptNuevo.groovy \
    --xpath //nodoOrigen=//nodoNuevo \
    --add-resource ./OrderRequest.xsd \
    --add-resource ./MM_Order_To_S4.mmap
  ```
- **Modo 4 (`export-api-client.mjs`):** Genera colecciones **Postman v2.1** (con pre-request handshake para CSRF) y especificaciones **OpenAPI 3.0.3** a partir de los canales inbound:
  ```bash
  node skills/sap-cpi-architect/scripts/export-api-client.mjs ./Paquete_iFlow.zip --out-dir ./clients
  ```
- **Modo 5 (`build-value-mapping.mjs`):** Construye paquetes OSGi de **Value Mapping** importables en SAP Integration Suite desde CSV o JSON:
  ```bash
  node skills/sap-cpi-architect/scripts/build-value-mapping.mjs ./valores.csv --name VM_Estados_S4 --out ./VM_Estados_S4.zip
  ```

---

## 6. Documentación Técnica Detallada

Para profundizar en la arquitectura, reglas de validación y parámetros de cada herramienta, consulta la carpeta [`docs/`](./docs/):

- [**Arquitectura del Proyecto (`docs/ARCHITECTURE.md`)**](./docs/ARCHITECTURE.md): Diseño sin dependencias, estructura de las Skills, motor ZIP nativo y flujo de trabajo híbrido IA + CLI.
- [**Referencia de Línea de Comandos (`docs/CLI_REFERENCE.md`)**](./docs/CLI_REFERENCE.md): Sintaxis detallada, opciones, esquemas JSON de entrada y códigos de retorno de todos los scripts.
- [**Reglas de Validación Determinista (`docs/VALIDATION_RULES.md`)**](./docs/VALIDATION_RULES.md): Catálogo completo de reglas BPMN 2.0, Groovy, XSLT, Regex, XSD y OSGi aplicadas por los validadores.
- [**Guía de Flujos de Trabajo (`docs/WORKFLOWS_GUIDE.md`)**](./docs/WORKFLOWS_GUIDE.md): Ejemplos prácticos de extremo a extremo para desarrollo, auditoría y empaquetado en SAP CPI.
- [**Base de Conocimiento y Lecciones Aprendidas (`docs/LESSONS_LEARNED.md`)**](./docs/LESSONS_LEARNED.md): Registro histórico anonimizado de errores reales en SAP CPI y su codificación en los motores CLI.

---

## 7. Harness de Aprendizaje Continuo (`AGENTS.md` / `rules/`)

El paquete incluye un **Harness de Auto-Mejora Continua** ([`AGENTS.md`](./AGENTS.md), [`CLAUDE.md`](./CLAUDE.md) y [`rules/sap-cpi-continuous-learning.md`](./rules/sap-cpi-continuous-learning.md)) que `setup-skills.mjs` instala automáticamente en `.agents/rules/` y `.claude/rules/`.

Cada vez que el usuario detecta un fallo al importar o ejecutar un artefacto en SAP CPI, corrige un resultado o comparte un paquete `.zip` de referencia, el agente:
1. Resuelve el problema inmediato en el artefacto del usuario.
2. **Anonimiza y abstrae** la regla técnica genérica (prohibiendo guardar nombres de proyectos privados, clientes, endpoints o valores de `.prop`).
3. **Codifica la validación o remediación** en el script CLI correspondiente (`skills/*/scripts/*.mjs`).
4. **Actualiza las `SKILL.md`**, [`docs/VALIDATION_RULES.md`](./docs/VALIDATION_RULES.md) y [`docs/LESSONS_LEARNED.md`](./docs/LESSONS_LEARNED.md).
5. Ejecuta `node verify-all.mjs` y `node setup-skills.mjs` para propagar la mejora.
