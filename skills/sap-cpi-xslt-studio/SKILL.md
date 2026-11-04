---
name: sap-cpi-xslt-studio
description: >-
  Use this skill when the user wants to generate, debug, or validate XSLT 1.0 (Apache Xalan)
  or XSLT 2.0/3.0 (Saxon-HE) transformation stylesheets for SAP Cloud Integration (CPI /
  Integration Suite), including multi-document lookups (document(), xsl:param) and SAP CPI
  Exchange extension functions (cpi:getHeader, cpi:setHeader, cpi:getProperty, cpi:setProperty).
---

# SAP CPI XSLT & Data Mapping Studio

Generates and validates production-ready XSLT 1.0 and XSLT 2.0/3.0 stylesheets (`src/main/resources/mapping/*.xslt`) tailored to SAP Cloud Integration's execution engines (**Saxon-HE** for 2.0/3.0 and **Apache Xalan** for 1.0).

## Workflow Steps

### Step 1: Determine Engine & Mapping Contract
1. **Select Engine**:
   - **XSLT 2.0 / 3.0 (Saxon-HE — Recommended)**: Supports `<xsl:for-each-group>`, `current-grouping-key()`, regex (`matches`, `tokenize`), and `exclude-result-prefixes="#all"`.
   - **XSLT 1.0 (Apache Xalan on SAP JVM)**: Uses Muenchian grouping (`<xsl:key>` + `key()`). **Never** use `#all` in `exclude-result-prefixes` or `<xsl:for-each-group>` in 1.0.
2. **Identify Input Documents**:
   - Primary Exchange Body (`/`)
   - Secondary bundle lookup via `document('lookup.xml')`
   - Secondary parameter XML via `<xsl:param name="lookupDoc"/>`
3. **Identify Exchange Header/Property Access**:
   - Check [xslt-scenarios.md](./references/xslt-scenarios.md) for the official `com.sap.it.rt.adapter.xpath.api.XmlExtFunctions` extension library syntax.

### Step 2: Author the Canonical XSLT Stylesheet
Follow these mandatory SAP CPI rules:
1. **No Curly Braces in Element Text Content (Anti-Hallucination Rule)**:
   - **PROHIBITED**: `<HeaderID>{//CABECERA/ID}</HeaderID>` or `<Qty>{$var}</Qty>`.
   - **REQUIRED**: Always use `<HeaderID><xsl:value-of select="//CABECERA/ID"/></HeaderID>`. Attribute Value Templates (`{...}`) are only valid inside XML attribute values (`<Order id="{OrderId}">`).
2. **Memory Optimization**:
   - Always include `<xsl:strip-space elements="*"/>` and `<xsl:output method="xml" encoding="UTF-8" indent="no"/>`.
3. **SAP CPI Exchange Extension Functions (when reading/writing Headers or Properties)**:
   - Declare `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` and `<xsl:param name="exchange"/>`.
   - Use `cpi:getHeader($exchange, 'HeaderName')`, `cpi:setHeader($exchange, 'HeaderName', 'Val')`, `cpi:getProperty($exchange, 'PropName')`, `cpi:setProperty($exchange, 'PropName', 'Val')`.

### Step 3: Validate the Stylesheet with `validate-xslt.mjs`
Save the generated XSLT and run the deterministic validator:

```bash
node ./scripts/validate-xslt.mjs <path-to-mapping.xslt> [--engine 2.0|1.0] [--json]
```

* Validator script: [validate-xslt.mjs](./scripts/validate-xslt.mjs)
* Reference scenarios: [xslt-scenarios.md](./references/xslt-scenarios.md)
* **Verification Gate**: Fix any reported anti-hallucination error, engine mismatch, or missing namespace/parameter declaration before delivering the final `.xslt` file.
