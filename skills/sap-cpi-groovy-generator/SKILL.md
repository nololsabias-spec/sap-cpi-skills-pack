---
name: sap-cpi-groovy-generator
description: >-
  Use this skill when the user wants to generate, author, or design a new Apache Groovy script
  for SAP Cloud Integration (SAP Integration Suite / CPI) from business requirements, input/output
  payload contracts (Body, Exchange Properties, Attachments), or canonical CPI architectural patterns.
---

# SAP CPI Groovy Script Generator

Generates production-ready, memory-safe Apache Groovy scripts for the official SAP Cloud Integration runtime (`Groovy 2.4/3.0+` on `SapMachine / SAP JVM`), strictly enforcing SAP Help Portal *Integration Flow Design Guidelines* and *Scripting Guidelines*.

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
Write the Groovy script adhering to these mandatory rules:
1. **Ensure Upgrade Readiness**: Include **only** the `import` statements actually used in the script. Never use wildcard imports (`import java.util.*`). Never import internal Camel classes (`org.apache.camel.impl.*`) or deprecated `groovy.util.XmlSlurper`.
2. **Signature & Return**: Always use `def Message processData(Message message)` and return `message`.
3. **Single-Argument `setBody`**: `message.setBody(output)` accepts **only one argument**. Always set the MIME type and charset separately via `message.setHeader("Content-Type", "application/json; charset=utf-8")`.
4. **Heap Safety & Streaming**: Never use `message.getBody(String)` or `new XmlParser()`. Always read payloads via `Reader bodyReader = message.getBody(java.io.Reader)` and close it deterministically in a `finally { bodyReader?.close() }` block or `.withReader`.Never declare `static def` variables.
5. **JSON & XML Safety**:
   - For JSON: Always use `groovy.json.JsonSlurperClassic` (never `groovy.json.JsonSlurper`).
   - For XML: Always use `new groovy.xml.XmlSlurper(false, false)` with `disallow-doctype-decl = true`, `external-general-entities = false`, and `external-parameter-entities = false`.
6. **Explicit UTC Timezone**: Never use `TimeZone.getDefault()` or `new Date().format(...)`. Always use `java.time.*` with `ZoneId.of("UTC")` (or explicit business zone).
7. **MPL Governance**: Obtain the log via `def messageLog = messageLogFactory?.getMessageLog(message)`. Index business keys with `messageLog?.addCustomHeaderProperty(key, val)`. Only create attachments (`addAttachmentAsString`) inside `catch` blocks or inside `if (message.getProperty("LogAttachments") == "Yes")`.
8. **Defensive Exception Handling**: Wrap logic in `try / catch (Exception e) / finally` and rethrow as `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.

### Step 3: Validate the Generated Script
Save the generated script to a file (or temporary file) and run the deterministic validator script:

```bash
node ./scripts/validate-groovy.mjs <path-to-script.groovy> [--strict] [--json]
```

* Validator script: [validate-groovy.mjs](./scripts/validate-groovy.mjs)
* **Verification Requirement**: The script must achieve a **100/100 score** with **0 Critical/High/Medium violations** before presenting the final code to the user. If `validate-groovy.mjs` reports any violation (e.g., an unused import, missing `disallow-doctype-decl`, or unclosed `Reader`), fix the Groovy code and re-run `validate-groovy.mjs` until it passes cleanly.
