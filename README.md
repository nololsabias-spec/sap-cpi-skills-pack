# SAP CPI AI Skills & Deterministic Validation Pack (`sap-cpi-skills-pack`)

Paquete portable de **8 Skills especializadas** y **scripts ejecutables de validación, linteo estático, inferencia y empaquetado OSGi (`.zip`)** para **SAP Cloud Integration (SAP Integration Suite / CPI)**.

Diseñado con **cero dependencias externas** (usa únicamente módulos nativos de Node.js `node:fs`, `node:zlib`, `node:path`, `node:child_process`) para que cualquier desarrollador o arquitecto de integración pueda clonarlo y usarlo al instante en **Antigravity**, **Claude Code**, **Cursor** o directamente desde la terminal.

---

## 1. Estructura del Proyecto

```text
sap-cpi-skills-pack/
├── README.md                           # Guía de instalación, arquitectura y uso de scripts
├── .gitignore                          # Reglas de exclusión para Git
├── package.json                        # Comandos rápidos (npm test y demos)
├── setup-skills.mjs                    # Instalador automático hacia .agents/ y .claude/
├── verify-all.mjs                      # Suite de auto-verificación de las 8 skills y scripts
├── shared/
│   └── zip-utils.mjs                   # Motor ZIP nativo en Node.js (lectura y escritura DEFLATE sin dependencias)
└── skills/
    ├── sap-cpi-zip-inspector/          # 1. Inspector de paquetes .zip y auditor de arquitectura BPMN 2.0 (.iflw)
    ├── sap-cpi-groovy-generator/       # 2. Generador de scripts Groovy con 10 directivas y validador estático
    ├── sap-cpi-code-auditor/           # 3. Auditor de seguridad/memoria Heap Groovy y Fast Refactor (Score 0-100)
    ├── sap-cpi-xslt-studio/            # 4. Generador y validador XSLT 1.0 (Xalan) y 2.0/3.0 (Saxon-HE)
    ├── sap-cpi-regex-studio/           # 5. Diseñador y Sandbox de Regex + Apache Camel Simple (Router/Modifier)
    ├── sap-cpi-xsd-studio/             # 6. Inferencia multi-muestra y validador W3C XSD 1.0 para Message Mapping
    ├── sap-cpi-mock-data-generator/    # 7. Generador, correlacionador E2E y empaquetador .zip de baterías de prueba
    └── sap-cpi-architect/              # 8. Generador de bundles OSGi (iFlow + Script Collection) y Documentador (8 secciones)
```

---

## 2. Cómo subirlo a Git y compartirlo con un amigo

### Subir esta carpeta a su propio repositorio Git
```bash
cd sap-cpi-skills-pack
git init
git add .
git commit -m "feat: SAP CPI Skills & Validation Scripts Pack"
git branch -M main
git remote add origin <URL_DE_TU_REPO_GIT>
git push -u origin main
```

### Cómo lo instala tu amigo en su entorno
Tu amigo solo necesita tener **Node.js (v18+)** instalado:
```bash
# 1. Clonar el repositorio
git clone <URL_DE_TU_REPO_GIT>
cd sap-cpi-skills-pack

# 2. Verificar que los 8 motores de validación pasan al 100% (cero npm install necesario)
npm test

# 3. Instalar las 8 skills en su proyecto de trabajo (crea .agents/skills y .claude/skills)
node ./setup-skills.mjs --target /ruta/a/su/proyecto
```

---

## 3. Catálogo de las 8 Skills y Validaciones Deterministas

| # | Skill (`skills/<nombre>/SKILL.md`) | Funcionalidad Cubierta | Script Ejecutable (`scripts/*.mjs`) | Validaciones Deterministas Incluidas |
| :- | :--- | :--- | :--- | :--- |
| **1** | `sap-cpi-zip-inspector` | **iFlow ZIP Package Inspector & BPMN 2.0 Auditor** | `inspect-iflow-zip.mjs` | Descomprime bundles `.zip` de SAP CPI, cataloga `MANIFEST.MF`, `.iflw`, `.groovy`, `.xslt`, `.prop` y audita los 5 puntos críticos BPMN2 (`Exception Subprocess`, canales `http://` sin TLS, credenciales/URLs hardcoded sin `{{param}}`, `ExternalCall` sin timeout, y Content Modifiers que copian `${body}` a Properties). |
| **2** | `sap-cpi-groovy-generator` | **Groovy Script Generator (10 Directivas + 5 Patrones)** | `validate-groovy.mjs` | Valida firma `def Message processData(Message message)`, `return message`, *Ensure Upgrade Readiness* (cero wildcards `.*`, cero imports no usados, cero APIs internas de Camel), protección XXE (`disallow-doctype-decl`), `JsonSlurperClassic`, streaming con `Reader` cerrado en `finally`, `ZoneId.of("UTC")`, MPL condicional, `setBody` de 1 argumento y prefijo `CPI-ERR:`. |
| **3** | `sap-cpi-code-auditor` | **Groovy Fast Refactor & Smart Auditor (2 Etapas)** | `audit-groovy.mjs` | Calcula el `Score de Calidad Original: X/100` con deducciones exactas (`CRÍTICA -30`, `ALTA -15`, `MEDIA -5`, `BAJA -2`), aplica el patrón One-Shot de refactorización y compara el script original contra el refactorizado verificando que alcance `100/100`. |
| **4** | `sap-cpi-xslt-studio` | **XSLT 1.0 (Xalan) & 2.0/3.0 (Saxon-HE) Studio** | `validate-xslt.mjs` | Detecta alucinaciones de llaves `{campo}` en texto de elementos XML, valida compatibilidad con XSLT 1.0 (prohíbe `#all` en `exclude-result-prefixes` y `xsl:for-each-group`) vs XSLT 2.0, verifica `<xsl:strip-space elements="*"/>` y valida `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` + `<xsl:param name="exchange"/>`. |
| **5** | `sap-cpi-regex-studio` | **CPI Regex & Apache Camel Simple Studio** | `test-camel-regex.mjs` | Verifica anclaje obligatorio `^...$`, detecta cuantificadores anidados con riesgo de **Catastrophic Backtracking (ReDoS)**, genera expresiones Camel Simple para Router (`regex`) y Content Modifier (`replaceAll`), y ejecuta un Sandbox en vivo contra casos `MATCH` y `NO_MATCH` extrayendo grupos `$1, $2...`. |
| **6** | `sap-cpi-xsd-studio` | **XSD 1.0 Schema Studio (Multi-Muestra)** | `validate-xsd.mjs` | Infiere esquemas W3C XSD 1.0 haciendo merge de N muestras JSON (asignando `minOccurs="0"` a campos opcionales/parciales) y valida compatibilidad con SAP CPI Message Mapping (prohíbe `<xsd:all>`, previene *Namespace Prefix Conflict* en `targetNamespace`, verifica `< 20.000` nodos y `elementFormDefault="qualified"`). |
| **7** | `sap-cpi-mock-data-generator` | **Multi-Payload Mock Data Suite Generator** | `pack-mock-suite.mjs` | Valida sintaxis JSON y XML de cada ejemplo generado, comprueba la **correlación E2E de claves de negocio** (`customerId`, `orderId`, `kunnr`, etc.) entre múltiples contratos y empaqueta la batería de pruebas en un `.zip` organizado por carpetas con `README_SUITE.txt`. |
| **8** | `sap-cpi-architect` | **CPI Architect (Modo 1: Generar iFlow + Script Collection / Modo 2: Documentar iFlow)** | `build-cpi-package.mjs` y `extract-for-docs.mjs` | **Modo 1**: Valida el `.iflw` BPMN2 y los scripts Groovy, y construye los 3 paquetes OSGi `.zip` reales (`<Iflow>.zip`, `<SC_Iflow>.zip` con `Require-Capability`/`Provide-Capability` y `Paquete_<Iflow>.zip`). **Modo 2**: Extrae metadatos/heurísticas de un `.zip` y valida que la documentación técnica cumpla las 8 secciones obligatorias. |

---

## 4. Comandos Rápidos de Uso y Demos

```bash
# Ejecutar la suite completa de verificación de las 8 skills:
npm test

# Demos individuales incluidas:
npm run demo:zip
npm run demo:auditor
npm run demo:xslt
npm run demo:regex
npm run demo:xsd
npm run demo:mock
npm run demo:architect
```
