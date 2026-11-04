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

### Instalar las Skills en un espacio de trabajo

El script `setup-skills.mjs` instala automáticamente las 8 skills y la librería compartida `shared/zip-utils.mjs` en las carpetas estándar de descubrimiento de agentes (`.agents/skills/` y `.claude/skills/`):

```bash
# Instalar en el directorio de un proyecto específico
node setup-skills.mjs --target /ruta/a/tu/proyecto

# Opciones adicionales de instalación:
node setup-skills.mjs --target /ruta/a/tu/proyecto --agents-only   # Solo en .agents/skills
node setup-skills.mjs --target /ruta/a/tu/proyecto --claude-only   # Solo en .claude/skills
```

---

## 3. Estructura del Proyecto

```text
sap-cpi-skills-pack/
├── README.md                           # Guía principal de instalación y uso
├── package.json                        # Scripts de verificación (npm test) y demostraciones
├── setup-skills.mjs                    # Instalador de skills en .agents/ y .claude/
├── verify-all.mjs                      # Suite de pruebas integrales de los 8 módulos
├── shared/
│   └── zip-utils.mjs                   # Motor ZIP nativo (lectura/escritura DEFLATE y CRC32)
├── docs/
│   ├── ARCHITECTURE.md                 # Arquitectura interna, flujo IA + CLI y motor ZIP
│   ├── CLI_REFERENCE.md                # Referencia completa de comandos, argumentos y flags
│   ├── VALIDATION_RULES.md             # Reglas de validación SAP CPI, scoring y seguridad
│   └── WORKFLOWS_GUIDE.md              # Flujos de trabajo prácticos paso a paso
└── skills/
    ├── sap-cpi-zip-inspector/          # 1. Inspector de paquetes .zip y auditor BPMN 2.0 (.iflw)
    ├── sap-cpi-groovy-generator/       # 2. Generador Groovy (10 directivas) y linter estático
    ├── sap-cpi-code-auditor/           # 3. Auditor de calidad/seguridad Groovy (Score 0-100)
    ├── sap-cpi-xslt-studio/            # 4. Validador y generador XSLT 1.0 (Xalan) y 2.0/3.0 (Saxon-HE)
    ├── sap-cpi-regex-studio/           # 5. Sandbox Regex + Apache Camel Simple (Router/Modifier)
    ├── sap-cpi-xsd-studio/             # 6. Inferencia multi-muestra y validador W3C XSD 1.0
    ├── sap-cpi-mock-data-generator/    # 7. Validador de correlación E2E y empaquetador de pruebas
    └── sap-cpi-architect/              # 8. Constructor de bundles OSGi (.zip) y Documentador técnico
```

---

## 4. Catálogo de las 8 Skills y Motores CLI

| # | Skill | Funcionalidad Principal | Script CLI |
| :- | :--- | :--- | :--- |
| **1** | `sap-cpi-zip-inspector` | Descomprime artefactos `.zip` (`IntegrationFlow`, `ScriptCollection` o paquetes anidados), redacta `.prop` por privacidad, inventaría recursos y audita riesgos BPMN 2.0 y reglas CPILint. | `inspect-iflow-zip.mjs` |
| **2** | `sap-cpi-groovy-generator` | Genera y valida scripts Groovy (Script v1 y Groovy 4 v2 API) individualmente o en lote (carpetas/`.zip`), aplicando prevención de OOM, anti-XXE, `@Field final` y *Ensure Upgrade Readiness*. | `validate-groovy.mjs` |
| **3** | `sap-cpi-code-auditor` | Audita scripts Groovy calculando una puntuación determinista (`0-100`), desglosa vulnerabilidades por severidad y verifica refactorizaciones. | `audit-groovy.mjs` |
| **4** | `sap-cpi-xslt-studio` | Genera y valida transformaciones XSLT 1.0 (Xalan) y XSLT 2.0/3.0 (Saxon-HE), incluyendo `json-to-xml()`, `<xsl:param>` e interacción con cabeceras/propiedades del Exchange (`cpi:*` / `sapci:*`). | `validate-xslt.mjs` |
| **5** | `sap-cpi-regex-studio` | Diseña y prueba expresiones regulares con anclaje `^...$`, detector estático de *Catastrophic Backtracking (ReDoS)* y expresiones Apache Camel Simple (`date-with-timezone`, listas `not in`). | `test-camel-regex.mjs` |
| **6** | `sap-cpi-xsd-studio` | Infiere esquemas W3C XSD 1.0 combinando múltiples muestras JSON (`minOccurs="0"` y `nillable="true"` automático según SAP Note `2624922`) y valida reglas de Message Mapping. | `validate-xsd.mjs` |
| **7** | `sap-cpi-mock-data-generator` | Valida sintaxis XML/JSON (incluyendo estándares IDoc `EDI_DC40` y OData `$batch`), comprueba la correlación E2E entre múltiples contratos y empaqueta suites `.zip`. | `pack-mock-suite.mjs` |
| **8** | `sap-cpi-architect` | **Modo 1:** Construye paquetes OSGi `.zip` duales (iFlow + Script Collection). **Modo 2:** Extrae metadatos y valida documentación técnica en 8 secciones. **Modo 3:** Clona y adapta bundles `.zip` de referencia según nuevas especificaciones API. | `build-cpi-package.mjs`<br>`extract-for-docs.mjs`<br>`clone-iflow-bundle.mjs` |

---

## 5. Guía de Uso por Módulo (CLI y Agentes IA)

### 5.1. Inspector y Auditor de Paquetes iFlow (`sap-cpi-zip-inspector`)

Analiza un paquete `.zip` exportado de SAP CPI (`IntegrationFlow`, `ScriptCollection` o paquetes compuestos con `.zip` anidados), redacta automáticamente los valores sensibles de `.prop` como `[REDACTED]` y detecta ausencia de `Exception Subprocess`, llamadas `http://` sin TLS, credenciales o URLs sin `{{param}}`, `ExternalCall` sin timeout, copias de `${body}` en propiedades, Splitters sin streaming y reglas CPILint (`CleartextBasicAuth`, `CsrfProtectionRequired`):

```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --json
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_iFlow.zip --extract-dir ./inspeccion
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

### 5.6. Inferencia Multi-Muestra y Validación XSD 1.0 (`sap-cpi-xsd-studio`)

Infiere esquemas W3C XSD 1.0 a partir de una o varias muestras JSON (marcando automáticamente como `minOccurs="0"` los campos que no aparecen en todas las muestras) y valida un XSD frente a las reglas del Message Mapping de SAP CPI:

```bash
# Inferir un XSD combinando múltiples muestras JSON y validarlo
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer ./muestra1.json ./muestra2.json \
  --root OrderRequest \
  --namespace "http://sap.com/xi/Orders" \
  --out ./OrderRequest.xsd

# Validar un archivo XSD existente
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs ./OrderRequest.xsd
```

### 5.7. Empaquetador de Baterías de Prueba E2E (`sap-cpi-mock-data-generator`)

Valida sintaxis XML/JSON, verifica que los identificadores de negocio (`orderId`, `customerId`, `kunnr`, etc.) estén correlacionados entre múltiples contratos y genera un paquete `.zip` estructurado por escenarios (`ok/`, `edge/`, `error/`):

```bash
node skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs --spec ./suite-spec.json --out ./MockSuite.zip
```

### 5.8. Arquitecto SAP CPI: Empaquetado OSGi, Clonación y Documentación (`sap-cpi-architect`)

- **Modo 1 (`build-cpi-package.mjs`):** Construye los paquetes `.zip` con estructura OSGi (`META-INF/MANIFEST.MF`, `.project`, `.iflw`, `parameters.prop` y `Script Collection` independiente vinculada por `Provide-Capability` / `Require-Capability`):
  ```bash
  node skills/sap-cpi-architect/scripts/build-cpi-package.mjs ./bundle-spec.json --out-dir ./dist
  ```
- **Modo 2 (`extract-for-docs.mjs`):** Extrae la topología completa de un paquete `.zip` y valida que el documento técnico Markdown cumpla las 8 secciones corporativas:
  ```bash
  node skills/sap-cpi-architect/scripts/extract-for-docs.mjs ./Paquete_iFlow.zip --validate-doc ./Documentacion_Tecnica.md
  ```
- **Modo 3 (`clone-iflow-bundle.mjs`):** Clona un iFlow `.zip` de referencia adaptando su identificador OSGi, scripts `.groovy` invocados y rutas XPath del Splitter (manteniendo intactos sus diagramas BPMN2 y archivos `.prop`), o inyecta nuevos scripts validados dentro de una `ScriptCollection.zip`:
  ```bash
  node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
    --source ./Referencia_iFlow.zip \
    --target-name Nuevo_iFlow_v1 \
    --out ./dist/Nuevo_iFlow_v1.zip \
    --replace ScriptOrigen.groovy=ScriptNuevo.groovy \
    --xpath //nodoOrigen=//nodoNuevo
  ```

---

## 6. Documentación Técnica Detallada

Para profundizar en la arquitectura, reglas de validación y parámetros de cada herramienta, consulta la carpeta [`docs/`](./docs/):

- [**Arquitectura del Proyecto (`docs/ARCHITECTURE.md`)**](./docs/ARCHITECTURE.md): Diseño sin dependencias, estructura de las Skills, motor ZIP nativo y flujo de trabajo híbrido IA + CLI.
- [**Referencia de Línea de Comandos (`docs/CLI_REFERENCE.md`)**](./docs/CLI_REFERENCE.md): Sintaxis detallada, opciones, esquemas JSON de entrada y códigos de retorno de todos los scripts.
- [**Reglas de Validación Determinista (`docs/VALIDATION_RULES.md`)**](./docs/VALIDATION_RULES.md): Catálogo completo de reglas BPMN 2.0, Groovy, XSLT, Regex, XSD y OSGi aplicadas por los validadores.
- [**Guía de Flujos de Trabajo (`docs/WORKFLOWS_GUIDE.md`)**](./docs/WORKFLOWS_GUIDE.md): Ejemplos prácticos de extremo a extremo para desarrollo, auditoría y empaquetado en SAP CPI.
