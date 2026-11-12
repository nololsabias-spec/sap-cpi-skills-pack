---
name: sap-cpi-code-auditor
description: >-
  Use this skill when the user wants to audit, lint, refactor, or harden an existing
  SAP Cloud Integration (CPI / Integration Suite) Groovy script for memory leaks (Heap OOM,
  static variables), XXE vulnerabilities, JsonSlurper issues, default timezone risks,
  unconditional MPL attachments, or upgrade readiness violations.
---

# SAP CPI Groovy Fast Refactor & Smart Auditor

Implements the 2-Stage Inverted Auditor pipeline for SAP Cloud Integration Groovy scripts:
- **Stage 1 (Fast Refactor)**: Refactors and hardens the vulnerable Groovy script using the canonical SAP One-Shot Golden Example so it achieves 100/100 compliance.
- **Stage 2 (Explain Diff & Findings Matrix)**: Calculates the exact `Score de Calidad Original: X/100` (deducting Critical `-30`, High `-15`, Medium `-5`, Low `-2`) and produces the comparative vulnerability matrix.

## Workflow Steps

### Step 0: Interactive Discovery & Clarification Gate
Before refactoring the Groovy script, check whether the user's prompt provides enough context for a lossless refactor. **If critical details are ambiguous, ask concise clarifying questions before altering business logic**:
1. **Payload Volume & Structure**: If the script parses XML/JSON without clear structure (or mixes read-only extraction with in-place node mutation), ask whether the payload is read-only (`XmlSlurper`) or mutated in-place (`XmlParser`) and what average/peak payload size is expected.
2. **Business Keys for Custom Header Properties**: Ask which business identifier field (e.g., `OrderID`, `InvoiceNumber`, `KUNNR`) should be indexed in the SAP CPI Message Processing Log (`messageLog.addCustomHeaderProperty`).
3. **Target Timezone & Error Contract**: Confirm whether timestamps must strictly use `UTC` or a specific local business timezone (e.g., `Europe/Madrid`), and whether exceptions should rethrow to trigger the CPI `Exception Subprocess`.

> **Fast-Track Rule**: If the script's intent is self-contained or the user asks for an immediate audit/refactor, run Step 1 immediately and state any assumptions clearly.

### Step 1: Run Static Pre-Audit on the Original Script
Run `audit-groovy.mjs` against the original script (or `--demo` to test the canonical vulnerable script):

```bash
node ./scripts/audit-groovy.mjs <original-script.groovy> [--json]
```

* Auditor script: [audit-groovy.mjs](./scripts/audit-groovy.mjs)
* One-Shot Golden Example reference: [one-shot-refactor.md](./references/one-shot-refactor.md)

### Step 2: Refactor & Harden the Script (Stage 1)
Following the findings from Step 1 and the canonical One-Shot pattern in [one-shot-refactor.md](./references/one-shot-refactor.md), produce the refactored Groovy script applying all 8 mandatory remediations:
1. Eradicate all `static def` / `static Map` / `static List` fields.
2. Replace `JsonSlurper` with `groovy.json.JsonSlurperClassic`; replace `XmlParser` with `new XmlSlurper(false, false)` (`import groovy.util.XmlSlurper` in Groovy 2.4 Script v1 / `import groovy.xml.XmlSlurper` in Groovy 4 Script v2) + `disallow-doctype-decl = true`.
3. Replace `message.getBody(String)` with `Reader bodyReader = message.getBody(java.io.Reader)` and close it in `finally { bodyReader?.close() }`. Never call `bodyReader.getText('UTF-8')` on a `Reader` (`BufferedReader` / `StringReader`) because `Reader.getText()` in Groovy takes **no** charset argument (calling `.getText('UTF-8')` throws `MissingMethodException`); pass `bodyReader` directly to `.parse(bodyReader)` or call `bodyReader.getText()` without arguments.
4. Replace `new Date().format(...)` or `TimeZone.getDefault()` with `java.time.Instant` + `DateTimeFormatter` + `ZoneId.of("UTC")`.
5. Make `messageLog.addAttachmentAsString(...)` strictly conditional (`if (message.getProperty("LogAttachments") == "Yes")` or inside `catch`); index business IDs with `messageLog?.addCustomHeaderProperty(...)`.
6. Keep **only** used imports; remove all wildcard imports (`import java.util.*`).
7. Ensure single-argument `message.setBody(output)` and set `message.setHeader("Content-Type", "...; charset=utf-8")`.
8. In `catch (Exception e)`, log error trace attachment and rethrow `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.
9. **Comments & documentation** ([`rules/sap-cpi-code-documentation.md`](../../rules/sap-cpi-code-documentation.md)): whenever the refactor adds or changes comments, or the user asks for the script to be commented/documented, apply the canonical standard.
   - Line-1 `/** ... */` header with summary, `Motivo:`, `Paso Script:`, `Entrada:`, `Salida:`, `Errores:`, `Historial:` and `@version`.
   - Groovydoc on helper methods.
   - Inline `//` comments only for the *why*.
   - Remove banners, commented-out code and TODOs, plus any email, endpoint, IP or secret found in comments (report the last two as security findings).
   - Bump `@version` and add a `Historial:` entry describing the refactor.
   - Get the skeleton with `node ../sap-cpi-groovy-generator/scripts/validate-groovy.mjs <script> --doc-header --groovy <v>` and never invent contracts you cannot read from the code; ask instead.

### Step 3: Verify the Refactored Script & Generate the Comparative Matrix (Stage 2)
Save the refactored script and run `audit-groovy.mjs` comparing the original and refactored files:

```bash
node ./scripts/audit-groovy.mjs <original-script.groovy> --refactored <refactored-script.groovy> [--groovy 2.4|4] [--docs]
```

* Secrets, emails, real endpoints or IPs in comments are always reported (`DOC_SECRET_IN_COMMENT` / `DOC_SENSITIVE_COMMENT`), with or without `--docs`.
* **`--docs`**: also enforces the documentation standard on both scripts. Use it when the refactor touches comments or the user asked for documentation; the refactored script must still reach 100/100.

* **Validation Gate**: Confirm that the refactored script achieves `Score Refactored: 100/100 (APROBADO)`.
* Present the refactored Groovy code block first, followed by `Score de Calidad Original: X/100` and the Markdown vulnerability table generated by the comparison.


## Qué garantiza el script (LL-026)

- Las reglas estructurales se evalúan con los literales String enmascarados (`stripStringLiterals`): `"new XmlParser()"` dentro de un texto no es un hallazgo. Los literales que importan (prefijo `CPI-ERR:`, nombres de cabecera, secretos) se siguen leyendo del código original.
- CLI: las flags pueden ir antes del archivo, `--groovy 2.4|4` está soportado, una carpeta o un `.zip` dan un error limpio con exit 2 (para carpetas y `.zip` usa `validate-groovy.mjs`), y sin archivo → exit 2.

## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un **error de compilación o runtime en SAP CPI**, corrija un script refactorizado o comparta un nuevo antipatrón de Groovy 2.4, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente la regla técnica genérica de Groovy 2.4 / SAP CPI, sin guardar jamás nombres de proyectos privados, clientes, endpoints ni valores de `.prop`.
2. **Codificar en el Script CLI**: Actualizar `validate-groovy.mjs` / `audit-groovy.mjs` para detectar determinísticamente ese caso en el futuro.
3. **Actualizar Documentación y Lecciones**: Documentar la regla en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
