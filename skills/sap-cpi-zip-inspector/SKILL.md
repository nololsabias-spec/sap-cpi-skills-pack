---
name: sap-cpi-zip-inspector
description: >-
  Use this skill when the user wants to inspect, extract, analyze, or audit an exported
  SAP Cloud Integration (CPI / Integration Suite) iFlow or Script Collection .zip bundle,
  or audit a BPMN 2.0 (.iflw) XML file for security, TLS, timeout, heap memory, and
  Exception Subprocess compliance.
---

# SAP CPI iFlow ZIP Package Inspector & BPMN 2.0 Auditor

This skill inspects OSGi `.zip` bundles exported from SAP Cloud Integration (SAP Integration Suite), extracts their internal catalog (`MANIFEST.MF`, `*.iflw`, `*.groovy`, `*.xslt`, `parameters.prop`, `parameters.propdef`), executes deterministic security and architecture heuristics on the `.iflw` BPMN 2.0 XML, and generates a complete architectural audit report.

## Workflow Steps

### Step 0: Interactive Discovery & Clarification Gate
Before running the audit or generating the remediation plan, check if any context is missing and **ask brief clarifying questions when needed**:
1. **Target Artifact Path**: If the user has not specified which `.zip` bundle or `.iflw` file to inspect, ask for the path (or offer to run `--demo` on a sample bundle).
2. **Operational & Landscape Context**: If architectural findings depend on the deployment environment (e.g., whether an internal endpoint is behind SAP Cloud Connector where `http://` virtual hosts are intentional, expected payload sizes in MB, or corporate timeout SLAs), ask the user so the remediation report is tailored and accurate.
3. **Remediation Depth**: Ask whether they want only the diagnostic audit report (`0–100` score + findings matrix) or if they also want the refactored Groovy scripts and patched `.iflw` generated automatically.

### Step 1: Run Deterministic Bundle Extraction & Static Heuristics
Execute the inspection script against the user's `.zip` package (`IntegrationFlow`, `ScriptCollection`, or multi-bundle outer `.zip`) or `.iflw` XML file (or run with `--demo` to generate and inspect a sample vulnerable iFlow bundle):

```bash
# Inspección estándar (consola o JSON)
node ./scripts/inspect-iflow-zip.mjs <path-to-iflow.zip-or-.iflw> [--extract-dir <output-folder>] [--show-prop-values] [--json]

# Exportar resumen y matriz de hallazgos directamente en PDF
node ./scripts/inspect-iflow-zip.mjs <path-to-iflow.zip-or-.iflw> --pdf <Informe_Auditoria.pdf>

# Generar un nuevo paquete .zip aplicando únicamente los cambios autorizados por el usuario
node ./scripts/inspect-iflow-zip.mjs <path-to-iflow.zip> --remediate <manifest,https,timeouts,streaming,csrf|all> --out <iFlow_Corregido.zip>
```

* Resource script: [inspect-iflow-zip.mjs](./scripts/inspect-iflow-zip.mjs)
* Native PDF generator: [pdf-utils.mjs](../../../shared/pdf-utils.mjs)
* Audit rules reference: [iflw-audit-rules.md](./references/iflw-audit-rules.md)
* **Privacy-First Default**: By default, `inspect-iflow-zip.mjs` redacts all parameter values in `.prop` files (`key=[REDACTED]`) so private endpoints, queue names, or credentials are never exposed in logs or AI context unless `--show-prop-values` is explicitly requested.
* **Multi-Bundle & Script Collection Support**:
  - Automatically detects outer `.zip` deliveries containing nested `.zip` bundles (`nestedBundles`) and inspects each inner bundle.
  - Distinguishes `SAP-BundleType: ScriptCollection` bundles from `IntegrationFlow` bundles, verifying `Provide-Capability` and cataloged `.groovy` scripts instead of penalizing for the absence of an `.iflw` file.
  - Extracts external `scriptCollection` and `.groovy` script dependencies referenced inside `<ifl:property>` blocks of an `.iflw` file.

### Step 2: Validate the 5 Critical Architecture Control Points
Review the deterministic output from `inspect-iflow-zip.mjs` across these 5 mandatory SAP CPI architectural dimensions:
1. **Exception Subprocess Presence (`CRITICAL` -30 pts if absent)**:
   - Verifies that `<bpmn2:process>` contains a `<bpmn2:subProcess triggeredByEvent="true">` or `ErrorEventSubProcessTemplate` / `ExceptionSubProcess`. Without it, unhandled runtime errors terminate the flow silently without alerting or compensation.
2. **Unencrypted Channels (`CRITICAL` / `HIGH` -15 pts each)**:
   - Flags any `<ifl:property key="address">` or endpoint using plain `http://` instead of `https://` / TLS.
3. **Unexternalized / Hardcoded Parameters (`HIGH` -15 pts each)**:
   - Flags hardcoded endpoint URLs, passwords, secrets, or tokens in `<ifl:property>` that do not use SAP CPI externalized parameter syntax `{{ParameterName}}`.
4. **Synchronous Request-Reply Calls Without Timeout (`MEDIUM` -5 pts each)**:
   - Detects `<bpmn2:serviceTask>` or `<bpmn2:callActivity>` with `activityType="ExternalCall"` missing an explicit `timeout` property, which risks exhausting worker node threads.
5. **Heap-Risk Content Modifiers (`CRITICAL` -30 pts each)**:
   - Detects Content Modifiers copying `${body}` or `in.body` into an Exchange Property, which duplicates the entire payload in JVM Heap memory.
6. **OSGi Manifest & Root Structure Compliance (`CRITICAL` -40 pts each — `manifestIssues`)**:
   - Flags any bundle where `META-INF/MANIFEST.MF` is nested inside a subfolder (e.g. `MyIflow/META-INF/MANIFEST.MF` instead of root `META-INF/MANIFEST.MF`), missing, or has any line exceeding **72 bytes UTF-8**, which causes SAP CPI to reject the upload with `Upload the artifact failed. The project must contain a valid manifest file`.
7. **CPILint & SAP Design Guideline Advisory Checks**:
   - **Splitter Streaming (`splittersWithoutStreaming`)**: Flags `General`/`Iterating Splitter` steps with `streaming="false"`.
   - **Router Default Route (`routersWithoutDefaultRoute`)**: Flags `<bpmn2:exclusiveGateway>` elements missing a `default` route.
   - **Basic Auth & CSRF Protection (`basicAuthChannels` / `csrfDisabledChannels`)**: Flags channels using `BasicAuthentication` (CPILint `CleartextBasicAuth`) or disabling CSRF protection (`xsrfProtection=0` — CPILint `CsrfProtectionRequired`).

### Step 3: Cross-Module Code Audit (When Groovy Scripts Exist)
If `inspect-iflow-zip.mjs` detects Groovy scripts in `src/main/resources/script/*.groovy`, run the Groovy Code Auditor skill (`sap-cpi-code-auditor`) on each extracted script to check for Heap OOM, XXE, and `static def` memory leaks.

### Step 4: Present Executive Summary & Interactive Deliverable Selection (PDF / Detailed Response / Selective Auto-Remediation)
1. **Present Concise Executive Summary**:
   - Show the **OSGi Bundle Metadata** (`Bundle-SymbolicName`, `Bundle-Version`, catalog counts of `.iflw`, `.groovy`, `.xslt`, `.mmap`, `.xsd`, `.prop`), the **Compliance Score (`0–100`)**, and a compact summary of the findings detected.
2. **Interactive Deliverable & Remediation Gate (Mandatory Question)**:
   - After showing the executive summary, **always ask the user which option(s) they want to execute**:
     - **Opción 1 · Generar un PDF con el resumen y detalle de todo lo encontrado**: Ejecuta `node ./scripts/inspect-iflow-zip.mjs <paquete.zip> --pdf <Informe_Auditoria.pdf>` para entregar un informe PDF ejecutivo y técnico listo para compartir.
     - **Opción 2 · Mostrar una respuesta larga y detallada en el chat**: Despliega el informe técnico completo en Markdown con la tabla exhaustiva de hallazgos (`| Severidad | Componente Afectado | Hallazgo Técnico | Recomendación SAP Best Practice |`) y los pasos detallados de remediación en SAP Integration Suite Designer.
     - **Opción 3 · Generar el nuevo paquete iFlow (`.zip`) con los cambios propuestos que sean posibles**:
       - **Regla de Confirmación Previa Obligatoria**: Antes de modificar o empaquetar el `.zip`, muestra al usuario la lista numerada de cambios propuestos detectados en `heuristics.availableRemediations` (y en los scripts Groovy si los hubiera) y **pregúntale siempre cuáles de esos cambios específicos desea aplicar**:
         - `manifest`: Mover `.project` y `META-INF/MANIFEST.MF` a la raíz del `.zip` (eliminando carpetas contenedoras intermedias) y plegar líneas a 72 bytes UTF-8.
         - `https`: Actualizar canales `http://` a `https://`.
         - `timeouts`: Añadir `httpRequestTimeout = 60000` ms en llamadas síncronas `ExternalCall` sin timeout.
         - `streaming`: Activar `<key>streaming</key><value>true</value>` en pasos `Splitter`.
         - `csrf`: Activar `<key>xsrfProtection</key><value>1</value>` en canales HTTP modificadores.
         - Refactorización de scripts `.groovy` incluidos (si el paquete contiene scripts con hallazgos).
       - Una vez que el usuario confirme qué cambios desea aplicar, ejecuta `inspect-iflow-zip.mjs <paquete.zip> --remediate <cambios_elegidos> --out <Paquete_Corregido.zip>` (sin tocar nunca los valores privados de `.prop`) y entrégale el `.zip` resultante validado.


## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un fallo al subir o ejecutar un `.zip` en SAP CPI o comparta paquetes de referencia para inspección, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente la regla estructural o heurística genérica de BPMN2 `.iflw` / OSGi `MANIFEST.MF`, sin guardar jamás nombres de proyectos privados, clientes, endpoints ni valores de `.prop`.
2. **Codificar en el Script CLI**: Actualizar `./scripts/inspect-iflow-zip.mjs` (y sus reglas de autorremediación `--remediate`) para cubrir el nuevo caso.
3. **Actualizar Documentación y Lecciones**: Documentar la regla en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
