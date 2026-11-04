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

### Step 1: Identify Target Component & Field
1. **Target Component**:
   - `Router` / `Filter`: Emits `${header.FieldName} regex '^pattern$'` (or `!regex`).
   - `Content Modifier`: Emits `${header.FieldName.replaceAll('^pattern$', '$1')}` and the CPI table configuration (`Pattern: ^pattern$ | Replacement: $1`).
2. **Presets Reference**: Check [regex-presets.md](./references/regex-presets.md) for the 5 canonical SAP CPI patterns (`CamelHttpPath`, group extraction, SAP `KUNNR`, `RFC 5322` corporate email, `UUID v4`).

### Step 2: Author the Pattern Following SAP CPI Ground Truth Rules
1. **Mandatory Anchoring (`^...$`)**: Every pattern MUST start with `^` and end with `$`. Never emit floating sub-patterns like `(\d+)` without modeling the full string structure (e.g., `^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$`).
2. **Anti-ReDoS (Catastrophic Backtracking Mitigation)**: Never nest unbounded quantifiers such as `(.*)+` or `([a-zA-Z0-9]+)+` that can freeze CPI worker threads at 100% CPU.
3. **Standard Single-Escape Syntax for CPI UI**: Use standard Java/CPI escapes (`\d`, `\w`, `\.`) and **never** escape forward slashes (`/api/v1/...`, never `\/api\/v1\/...`).

### Step 3: Execute the Sandbox & Validator Script (`test-camel-regex.mjs`)
Always validate the pattern and test cases (`MATCH` and `NO_MATCH`) using `test-camel-regex.mjs`:

```bash
node ./scripts/test-camel-regex.mjs --pattern "^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$" --component "Content Modifier" --field '${header.InvoiceNumber}' --match "INV-2026-99382-ES|ORD-2025-100-DE" --no-match "INV-99382-ES|2026-99382"
```

* Sandbox & validator script: [test-camel-regex.mjs](./scripts/test-camel-regex.mjs)
* **Verification Gate**: All `--match` strings must evaluate to `MATCH`, all `--no-match` strings must evaluate to `NO_MATCH`, and 0 structural/ReDoS errors may remain. Deliver the 4 structured blocks: `[REGEX_PATTERN]`, `[CAMEL_SIMPLE]`, `[EXPLANATION]`, and `[TEST_CASES]`.
