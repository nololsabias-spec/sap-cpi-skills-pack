---
name: sap-cpi-groovy-generator
description: >-
  Use this skill when the user wants to generate, author, or design a new Apache Groovy script
  for SAP Cloud Integration (SAP Integration Suite / CPI) from business requirements, input/output
  payload contracts (Body, Exchange Properties, Attachments), or canonical CPI architectural patterns.
---

# SAP CPI Groovy Script Generator

Generates production-ready, memory-safe Apache Groovy scripts for the official SAP Cloud Integration runtime (Script step 1.1 = `Groovy 2.4`, Script step 2.0 = `Groovy 4.0.x`, on `SapMachine / SAP JVM`), strictly enforcing SAP Help Portal *Integration Flow Design Guidelines* and *Scripting Guidelines*.

## Workflow Steps

### Step 0: Interactive Discovery & Clarification Gate (Ask Before Assuming)
Before generating any Groovy code, inspect the user's prompt for missing functional or technical context. **If any of the following critical details are ambiguous or missing, ask concise, targeted clarifying questions (grouped in a single turn with recommended defaults) before writing the script**:
1. **Input & Output Payload Contracts**: What is the exact input format (XML, JSON, CSV, plain text) and target output structure? Ask for a sample payload or field names if not provided.
2. **Headers, Exchange Properties & Attachments**: Which SAP CPI Headers or Exchange Properties need to be read or written (e.g., `SAP_ApplicationID`, custom routing properties)?
3. **External CPI Services**: Does the script require `SecureStoreService` (credential alias name?), `ValueMappingApi` (agency/identifier?), or custom MPL attachments?
4. **Error & Edge-Case Behavior**: Should missing fields throw a hard `CPI-ERR:` exception to trigger the `Exception Subprocess`, or populate a default value / empty array?

> **Fast-Track Rule**: Only skip asking questions if the user's prompt already specifies the input/output contract and transformation rules, or if the user explicitly asks to proceed with sensible defaults.

### Step 1: Gather Message Contracts & Select Modular Directives
Identify from the user's request:
1. **Input Sources**: Body (`message.getBody(java.io.Reader)`), Exchange Properties (`message.getProperty('...')`), or Attachments (`message.getAttachments()`), plus expected Input Headers/Properties.
2. **Output Targets**: Body (`message.setBody(output)` + `message.setHeader('Content-Type', '...; charset=utf-8')`), Exchange Properties (`message.setProperty(k, v)`), or Conditional MPL Attachments, plus Output Headers/Properties.
3. **Applicable Modular Directives & Patterns**:
   - Consult [directives-catalog.md](./references/directives-catalog.md) for the 10 modular directives (`xmlSlurper`, `jsonProcessing`, `explicitTimezone`, `mplGovernance`, `upgradeReadiness`, `headersProperties`, `secureStore`, `valueMapping`, `attachments`, `exceptionHandling`) and 13 BTP cybersecurity conditions.
   - Consult [canonical-patterns.md](./references/canonical-patterns.md) if the request matches one of the 5 architectural patterns (Pattern A: XML Streaming, Pattern B: Headers/Properties, Pattern C: MPL Logging, Pattern D: JSON Manipulation, Pattern E: HMAC/Crypto & SecureStore).

### Step 2: Author the Canonical Groovy Script
Write the Groovy script adhering to these mandatory SAP Help Portal rules:
1. **Ensure Upgrade Readiness & Groovy 2.4 vs Groovy 4 Package Compatibility**:
   - Include **only** the `import` statements actually used in the script. Never use wildcard imports (`import java.util.*`).
   - Support either `import com.sap.gateway.ip.core.customdev.util.Message` (Script API v1) or `import com.sap.it.script.v2.api.Message` (Script API v2).
   - **The Groovy runtime (2.4 or 4) is selected in the iFlow Script step (Script step 2.0 = Groovy 4) and CANNOT be inferred from the Message import.** If the user has not said which version the step uses, ask (Step 0) and pass it to the validator with `--groovy 2.4|4`.
   - **`XmlSlurper` Package by Engine Version (`CRITICAL` Compile Error Prevention)**:
     - In **Groovy 2.4**, `XmlSlurper` lives in **`groovy.util.XmlSlurper`** (`import groovy.util.XmlSlurper`). **NEVER** write `import groovy.xml.XmlSlurper` in a Groovy 2.4 script — `groovy.xml.XmlSlurper` does not exist in Groovy 2.4 and fails at compilation with `unable to resolve class groovy.xml.XmlSlurper`.
     - In **Groovy 4**, `groovy.util.XmlSlurper` / `XmlParser` / `XmlNodePrinter` / `slurpersupport.GPathResult` were removed: use `import groovy.xml.XmlSlurper`. Also avoid `org.apache.camel.*` imports and GDK `Date.format()/Date.parse()` (use `java.time`).
   - Never import restricted/internal frameworks banned by SAP's *"Restrict usage to supported frameworks and libraries"* guideline (`org.apache.camel.impl.*`, `org.apache.camel.processor.*`, `com.sap.it.script.v2.api.proxy.*`, `org.osgi.framework.*`, `org.springframework.*`, `com.zaxxer.hikari.*`, `groovy.sql.*`, `org.quartz.*`, `net.sf.saxon.*`).
2. **Signature, Local Scoping & Return**:
   - Always use `def Message processData(Message message)` and return `message`.
   - Always declare local variables with `def` or an explicit type (`String`, `Map`, etc.) so they are never placed in the global script `Binding` (which leaks memory until iFlow redeployment).
   - Never instantiate `new GroovyShell().evaluate(...)` or `Eval.me(...)` (causes Metaspace `OutOfMemoryError`).
3. **Single-Argument `setBody` & `GString` Safety**:
   - `message.setBody(output)` accepts **only one argument**. Always set the MIME type and charset separately via `message.setHeader("Content-Type", "application/json; charset=utf-8")`.
   - When passing Groovy interpolated strings (`"ID_${id}"`) into `setHeader` or `setProperty`, explicitly coerce them to `java.lang.String` using `.toString()` or `as String` to prevent `GStringImpl` type mismatch errors in strict Java adapters.
4. **Heap Safety, Streaming, `Reader.getText()` Signature & Thread Safety**:
   - Prefer reading payloads via `Reader bodyReader = message.getBody(java.io.Reader)` and passing `bodyReader` directly to the parser (`jsonSlurper.parse(bodyReader)` / `xmlSlurper.parse(bodyReader)`), closing it deterministically in `finally { bodyReader?.close() }` or `.withReader`.
   - **Prohibition of `Reader.getText('UTF-8')` (`MissingMethodException`)**: In Java and Groovy, `Reader` (`BufferedReader`, `StringReader`) is already a character stream and **does NOT have a `.getText(String charset)` method**. Calling `bodyReader.getText('UTF-8')` throws `MissingMethodException: No signature of method: java.io.BufferedReader.getText() is applicable for argument types: (java.lang.String) values: [UTF-8]` (or `java.io.StringReader.getText()`). If you must materialize text from a `Reader`, call `bodyReader.getText()` **with zero arguments**!
   - For ultra-large XML payloads (> 30–50 MB), prefer StAX (`javax.xml.stream.XMLStreamReader` / `XMLStreamWriter`) event streaming over tree parsers.
   - Never declare `static def` variables, and if `@Field` (`groovy.transform.Field`) is used for script-level constants, always declare it `@Field final` (mutable `@Field` properties cause thread-safety race conditions across concurrent messages).
5. **JSON & XML Safety**:
   - For JSON: Always use `groovy.json.JsonSlurperClassic` (never `groovy.json.JsonSlurper`).
   - For XML: Always use `new XmlSlurper(false, false)` (`import groovy.util.XmlSlurper` in Groovy 2.4 / `import groovy.xml.XmlSlurper` in Groovy 4 v2) with `disallow-doctype-decl = true`, `external-general-entities = false`, and `external-parameter-entities = false`.
6. **Multi-Branch Gather Deduplication & Fallback Chains**:
   - When a script aggregates payloads after a `Parallel Multicast` + `Gather` step, deduplicate records in memory using a keyed `Map<String, Object>` (e.g., by `sys_id` or primary business key) before building the XML/JSON output for a downstream `Splitter`.
   - When an API specification defines primary vs. fallback/legacy fields or parent-entity dot-walking (`parent.field`), implement explicit Elvis fallback chains (`record.primaryField ?: record.legacyField ?: null`).
7. **Explicit UTC Timezone**: Never use `TimeZone.getDefault()` or `new Date().format(...)`. Always use `java.time.*` with `ZoneId.of("UTC")` (or explicit business zone).
8. **MPL Governance, Custom Status & `ITApiFactory` Service Limits (`PartnerDirectory`, `Keystore`, `ValueMapping`)**:
   - Obtain the log via `def messageLog = messageLogFactory?.getMessageLog(message)`. Index scalar business keys with `messageLog?.addCustomHeaderProperty(key, val)` (keep values concise `< 200` chars to protect the shared tenant MPL storage quota). Only create attachments (`addAttachmentAsString`) inside `catch` blocks, inside dedicated Exception Subprocess handlers (`if (map.get("CamelExceptionCaught") != null)`), or inside `if (message.getProperty("LogAttachments") == "Yes")`.
   - **Controlled Error / Custom MPL Status Pattern**: When an iFlow handles a business or controlled error without throwing an unhandled runtime crash, set `message.setProperty("SAP_MessageProcessingLogCustomStatus", "Controlled error")` (or `"Skipped"`, `"RetryScheduled"`) and optionally `messageLog?.setStringProperty("LogLevel", "ERROR")` so operators can filter controlled errors in the SAP CPI Monitor.
   - **`PartnerDirectoryService`**: Partner ID (`Pid`) max **60 chars**, Parameter ID (`Id`) max **1500 chars**. Never call Partner Directory inside a `Splitter` loop; look up parameters once before the Splitter and cache them in Exchange Properties.
   - **`KeystoreService` & `SecureStoreService`**: Keep certificate/key aliases concise (`< 25` chars), never decrypt private keys repeatedly inside message splits, and never log secrets or private keys to the MPL.
   - **`ValueMappingApi`**: Always implement a default fallback value when `getMappedValue(...)` returns `null` or empty.
9. **Defensive Exception Handling**: Wrap logic in `try / catch (Exception e) / finally` and rethrow as `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.

### Step 3: Validate the Generated Script (Single File, Folder, or Script Collection `.zip`)
Save the generated script(s) and run the deterministic validator script on the `.groovy` file, an entire script folder, or a packaged `.zip`:

```bash
node ./scripts/validate-groovy.mjs <path-to-script.groovy | folder | bundle.zip> [--groovy 2.4|4] [--strict] [--json]

# Canonical template for a given runtime
node ./scripts/validate-groovy.mjs --template xml-slurper --api v2 --groovy 4 --raw
```

* Validator script: [validate-groovy.mjs](./scripts/validate-groovy.mjs)
* **`--groovy 2.4|4`**: enables the hard compile-error rules for that runtime (`GROOVY24_INVALID_XMLSLURPER_IMPORT`, `GROOVY4_REMOVED_GROOVY_UTIL_XML`, `GROOVY4_CAMEL_IMPORT`, `GROOVY4_DATE_EXTENSIONS`). Without it, version-dependent XML APIs are reported as `GROOVY_VERSION_DEPENDENT_XML_API` (MEDIUM).
* **Verification Requirement**: The script must achieve a **100/100 score** with **0 Critical/High/Medium violations** before presenting the final code to the user. If `validate-groovy.mjs` reports any violation (e.g., an unused import, missing `disallow-doctype-decl`, or unclosed `Reader`), fix the Groovy code and re-run `validate-groovy.mjs` until it passes cleanly.


## Qué garantiza el script (LL-026)

- `validate-groovy.mjs` ignora patrones dentro de literales String (`stripStringLiterals`) y reporta la línea del código real.
- `--template` con `--groovy` o `--api` inválidos → exit 2 (no cae a 2.4/v1 en silencio). Las plantillas canónicas puntúan 100/100.
- Un `.zip` corrupto da "no se pudo leer X como ZIP" con exit 1, sin stack trace.

## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un **error de compilación o runtime en SAP CPI** (ej. firmas de métodos en Groovy 2.4, imports incompatibles, manejo de `Reader`/`InputStream`), corrija un script o comparta una Script Collection de ejemplo, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente la regla técnica genérica de Groovy 2.4 / SAP CPI, sin guardar jamás nombres de proyectos privados, clientes, endpoints ni valores de `.prop`.
2. **Codificar en el Script CLI**: Añadir la regla de validación en `./scripts/validate-groovy.mjs` para que el fallo quede bloqueado por código en futuras generaciones.
3. **Actualizar Documentación y Lecciones**: Documentar la regla en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
