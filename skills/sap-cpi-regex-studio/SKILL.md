---
name: sap-cpi-regex-studio
description: >-
  Use this skill when the user wants to design, test, or validate Regular Expressions (Java
  Pattern) and Apache Camel Simple expressions for SAP Cloud Integration (CPI) Routers,
  Message Filters, or Content Modifiers (replaceAll group extraction).
---

# SAP CPI Regex & Camel Simple Expression Studio

Designs, validates, and tests regular expressions and Apache Camel Simple predicates for SAP Cloud Integration Routers and Content Modifiers, enforcing mandatory `^...$` anchoring, ReDoS prevention, and live sandbox test case verification.

## Workflow Steps

### Step 0: Interactive Discovery & Clarification Gate (Ask Before Assuming)
Before designing the regular expression, check if the user's request leaves any boundary condition ambiguous. **Ask concise clarifying questions when needed**:
1. **Target SAP CPI Step & Source Variable**: Is the regex for a **Router / Filter** condition (`${property.x} regex '...'`) or for a **Content Modifier** value extraction/replacement (`replaceAll`)? What is the exact Header or Property name?
2. **Exact String Format & Edge Cases**: Ask for 2–3 real examples of strings that **must match** and strings that **must be rejected** (e.g., optional prefixes, allowed country codes, fixed vs variable digit length, case sensitivity).
3. **Replacement / Extraction Output**: If used in a Content Modifier, what exact substring or reformatted output (`$1`, `$2`) should be produced?

### Step 1: Identify Target Component & Field
1. **Target Component**:
   - `Router` / `Filter`: Emits `${header.FieldName} regex '^pattern$'` (or `!regex`).
   - `Content Modifier`: Emits `${header.FieldName.replaceAll('^pattern$', '$1')}` and the CPI table configuration (`Pattern: ^pattern$ | Replacement: $1`).
2. **Presets Reference**: Check [regex-presets.md](./references/regex-presets.md) for the 5 canonical SAP CPI patterns (`CamelHttpPath`, group extraction, SAP `KUNNR`, `RFC 5322` corporate email, `UUID v4`).

### Step 2: Author the Pattern Following SAP CPI Ground Truth Rules
1. **Mandatory Anchoring (`^...$`)**: Every pattern MUST start with `^` and end with `$`. Never emit floating sub-patterns like `(\d+)` without modeling the full string structure (e.g., `^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$`).
2. **Anti-ReDoS (Catastrophic Backtracking Mitigation)**: Never nest unbounded quantifiers such as `(.*)+` or `([a-zA-Z0-9]+)+` that can freeze CPI worker threads at 100% CPU.
3. **Standard Single-Escape Syntax for CPI UI**: Use standard Java/CPI escapes (`\d`, `\w`, `\.`) and **never** escape forward slashes (`/api/v1/...`, never `\/api\/v1\/...`).
4. **Content Modifier Pre-Extraction, Timezones & `not in` Workaround (SAP Official Simple Guidelines)**:
   - Never evaluate complex XPath or regex repeatedly across multiple Router branches. Instead, extract the XML value once in a preceding `Content Modifier` into a typed **Exchange Property** (`java.lang.String`), and evaluate `${property.FieldName} regex '^...$'` in the Router (reserving `${header.*}` only for protocol headers sent to external receivers).
   - **Inclusion / Exclusion Lists (`in` / `not in`)**: Because `not in` is not natively supported in all SAP CPI Simple expression dropdowns, implement list exclusion/inclusion via anchored alternation regex: `${property.Region} regex '^(US|CA|MX)$'` or `${property.Region} not regex '^(US|CA|MX)$'`.
   - **Timezone-Safe Timestamps Without Groovy**: Use `${date-with-timezone:now:UTC:yyyy-MM-dd'T'HH:mm:ss'Z'}` (or a regional IANA zone like `Europe/Madrid`) in Content Modifiers instead of `${date:now:...}` to guarantee deterministic timezone formatting.
   - When extracting from XML payloads with shifting or default namespaces in a Content Modifier, use explicit namespace mappings or fallback to `//*[local-name()='ElementName']`.

### Step 3: Execute the Sandbox & Validator Script (`test-camel-regex.mjs`)
Always validate the pattern and test cases (`MATCH` and `NO_MATCH`) using `test-camel-regex.mjs`:

```bash
node ./scripts/test-camel-regex.mjs --pattern "^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$" --component "Content Modifier" --field '${header.InvoiceNumber}' --match "INV-2026-99382-ES|ORD-2025-100-DE" --no-match "INV-99382-ES|2026-99382"
```

* Sandbox & validator script: [test-camel-regex.mjs](./scripts/test-camel-regex.mjs)
* **Verification Gate**: All `--match` strings must evaluate to `MATCH`, all `--no-match` strings must evaluate to `NO_MATCH`, and 0 structural/ReDoS errors may remain. Deliver the 4 structured blocks: `[REGEX_PATTERN]`, `[CAMEL_SIMPLE]`, `[EXPLANATION]`, and `[TEST_CASES]`.


## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un fallo de evaluación en un Router/Filter/Content Modifier de SAP CPI (expresiones Camel Simple o Java Regex), tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente el patrón técnico genérico de Camel Simple / Java Pattern, sin guardar jamás datos de proyectos privados o clientes.
2. **Codificar en el Script CLI**: Actualizar `./scripts/test-camel-regex.mjs` / `./scripts/test-cpi-regex.mjs` para cubrir el nuevo caso.
3. **Actualizar Documentación y Lecciones**: Documentar la mejora en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
