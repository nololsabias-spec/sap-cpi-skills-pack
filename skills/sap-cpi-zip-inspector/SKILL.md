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
node ./scripts/inspect-iflow-zip.mjs <path-to-iflow.zip-or-.iflw> [--extract-dir <output-folder>] [--show-prop-values] [--json]
```

* Resource script: [inspect-iflow-zip.mjs](./scripts/inspect-iflow-zip.mjs)
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

### Step 3: Cross-Module Code Audit (When Groovy Scripts Exist)
If `inspect-iflow-zip.mjs` detects Groovy scripts in `src/main/resources/script/*.groovy`, run the Groovy Code Auditor skill (`sap-cpi-code-auditor`) on each extracted script to check for Heap OOM, XXE, and `static def` memory leaks.

### Step 4: Produce the Final Architectural Audit Report
Present the final report in Markdown containing:
- **OSGi Bundle Metadata**: `Bundle-SymbolicName`, `Bundle-Name`, `Bundle-Version`, file catalog counts.
- **Compliance Score (`0–100`)**: Calculated from the deterministic findings.
- **Findings Matrix Table**:
  `| Severidad (CRÍTICA/ALTA/MEDIA/LEVE) | Componente Afectado | Hallazgo Técnico | Recomendación SAP Best Practice |`
- **Actionable Remediation Steps**: Exact steps to fix each issue inside the SAP Integration Suite Designer.
