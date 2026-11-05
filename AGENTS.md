# AI Agent Harness — SAP CPI Skills Pack (`AGENTS.md` / `CLAUDE.md`)

Este archivo actúa como el **Harness de Ingeniería y Aprendizaje Continuo** para cualquier agente de IA (Google Antigravity, Claude Code, Cursor, GitHub Copilot) que utilice o mantenga el ecosistema **`sap-cpi-skills-pack`**.

---

## 1. Arquitectura del Ecosistema

El paquete consta de **8 Skills deterministas** sin dependencias externas (`zero-dependency Node.js ES Modules`) y una capa compartida en `shared/`:

- `shared/zip-utils.mjs`: Empaquetado/desempaquetado ZIP en memoria (DEFLATE/STORE), normalización de `META-INF/MANIFEST.MF` en raíz y plegado RFC 2822 a 72 bytes UTF-8 (`wrapManifestLine72`).
- `shared/pdf-utils.mjs`: Generador nativo de informes PDF 1.4 (`WinAnsiEncoding`, multipágina, tablas y bloques de código) sin librerías externas.
- `skills/sap-cpi-architect`: Diseño desde cero (3 etapas), documentación técnica corporativa de 8 secciones en PDF/MD (`extract-for-docs.mjs`), clonación/adaptación (`clone-iflow-bundle.mjs`), exportación de clientes de pruebas Postman v2.1 y OpenAPI 3.0 (`export-api-client.mjs`), y constructor de Value Mappings OSGi (`build-value-mapping.mjs`).
- `skills/sap-cpi-zip-inspector`: Auditoría estática de paquetes `.zip` e `.iflw`, generador de resumen PDF (`--pdf`), autorremediación interactiva (`--remediate ... --out`), y comparador semántico de paquetes y control de versiones (`diff-iflow-zip.mjs`).
- `skills/sap-cpi-groovy-generator` & `skills/sap-cpi-code-auditor`: Generación y auditoría AST/heurística de Groovy 2.4 / 4 (`validate-groovy.mjs`, `audit-groovy.mjs`).
- `skills/sap-cpi-xslt-studio`: Generación y validación XSLT 1.0 (Xalan) / 2.0 (Saxon-HE) (`validate-xslt.mjs`).
- `skills/sap-cpi-xsd-studio`: Inferencia multi-muestra y validación XSD 1.0 (`validate-xsd.mjs`), generador de mapeos gráficos (`build-mmap.mjs`) y simulador de ejecución de mapeos gráficos .mmap con payloads XML/JSON (`simulate-mmap.mjs`).
- `skills/sap-cpi-regex-studio`: Laboratorio Regex Java y expresiones Camel Simple (`test-camel-regex.mjs`).
- `skills/sap-cpi-mock-data-generator`: Generación de suites de pruebas E2E e integridad referencial (`pack-mock-suite.mjs`).

---

## 2. Harness de Aprendizaje Continuo (Self-Improving Loop)

Cada vez que el usuario utilice una skill y durante las pruebas en SAP CPI aparezca un **error de subida/ejecución**, el usuario **corrija un resultado**, o el usuario **comparta un iFlow/Script Collection de ejemplo**, el agente **DEBE** aplicar automáticamente este ciclo de 5 pasos:

1. **Corregir el problema inmediato del usuario** en su artefacto de trabajo.
2. **Anonimizar y Abstraer (Zero Data Leakage)**:
   - Extraer la regla técnica genérica de SAP CPI.
   - **PROHIBIDO** guardar o subir a Git nombres de proyectos privados, nombres de clientes, URLs/endpoints reales, credenciales o valores de `.prop`.
   - **PROHIBIDO** leer o imprimir valores de archivos `.prop` privados.
3. **Actualizar el Script CLI Determinista**:
   - Programar la nueva regla o validación en el script `.mjs` correspondiente (`validate-groovy.mjs`, `inspect-iflow-zip.mjs`, `build-cpi-package.mjs`, `clone-iflow-bundle.mjs`, etc.) para que el fallo quede prevenido por código en futuras ejecuciones.
4. **Actualizar `SKILL.md` y Documentación Viva**:
   - Actualizar la `SKILL.md` implicada y sus `references/`.
   - Actualizar `docs/VALIDATION_RULES.md` (si hay nueva regla de validación) y registrar la lección aprendida en `docs/LESSONS_LEARNED.md`.
5. **Ejecutar Verificación y Sincronización**:
   - Ejecutar `node verify-all.mjs` (debe dar `15/15 PASS`).
   - Ejecutar `node setup-skills.mjs --target <ruta-workspace>` para sincronizar `.agents/` y `.claude/`.
