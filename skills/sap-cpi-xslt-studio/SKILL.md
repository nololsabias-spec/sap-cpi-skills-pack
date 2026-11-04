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

### Step 0: Interactive Discovery & Clarification Gate (Ask Before Assuming)
Before authoring the XSLT stylesheet, inspect the user's prompt. **If any of the following mapping specifications are missing or ambiguous, ask targeted clarifying questions first**:
1. **Source & Target XML Structures**: Ask for sample source XML and expected target XML (or XSD schemas), including namespaces and prefixes, if not provided.
2. **SAP CPI XSLT Engine Version**: Confirm whether the iFlow step uses **XSLT 2.0 / 3.0 (Saxon-HE — recommended)** or legacy **XSLT 1.0 (Apache Xalan)**, as grouping and functions differ completely.
3. **Exchange Headers / Properties & Lookups**: Ask if the transformation needs to read/write SAP CPI Headers or Exchange Properties (`cpi:getHeader`, `cpi:setProperty`) or merge a secondary XML document (`<xsl:param>` / `document()`).
4. **Null / Missing Field Rules**: Ask how optional or empty nodes should be handled (omit the target tag, emit an empty tag, or output a default value).

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
2. **Memory & Streaming Optimization (SAP Official Guidelines)**:
   - Always include `<xsl:strip-space elements="*"/>` and `<xsl:output method="xml" encoding="UTF-8" indent="no"/>`.
   - Avoid unrestricted descendant axes (`//Node`) and heavy global `<xsl:key>` indexes on massive XML documents (> 50 MB); prefer explicit relative paths (`/Root/Items/Item`).
   - When designing XSLT 3.0 stylesheets on Saxon-HE for ultra-large streaming payloads, structure templates sequentially and use `<xsl:mode streamable="yes"/>` where supported.
3. **SAP CPI Exchange Headers, Properties & Native JSON-to-XML (XSLT 3.0)**:
   - **Inbound Headers & Properties (Zero-Extension Binding)**: SAP CPI automatically injects any Message Header or Exchange Property into a global `<xsl:param name="HeaderOrPropertyName" select="'DEFAULT'"/>` declared directly under `<xsl:stylesheet>`. Prefer `<xsl:param>` with a default `select` fallback for read-only access.
   - **Outbound Headers & Properties (Extension Functions)**: Declare `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` (or `xmlns:sapci="http://sap.com/it/"`) and `<xsl:param name="exchange"/>`. Use `cpi:setHeader($exchange, 'HeaderName', 'Val')` and `cpi:setProperty($exchange, 'PropName', 'Val')`.
   - **Native XSLT 3.0 `json-to-xml()` & Identity Mode**: In XSLT 3.0 (`version="3.0"` on Saxon-HE), you can parse raw JSON strings directly via `json-to-xml(.)` using `xpath-default-namespace="http://www.w3.org/2005/xpath-functions"`, and replace verbose identity templates with `<xsl:mode on-no-match="shallow-copy"/>`.

### Step 3: Validate the Stylesheet with `validate-xslt.mjs`
Save the generated XSLT and run the deterministic validator:

```bash
node ./scripts/validate-xslt.mjs <path-to-mapping.xslt> [--engine 2.0|1.0] [--json]
```

* Validator script: [validate-xslt.mjs](./scripts/validate-xslt.mjs)
* Reference scenarios: [xslt-scenarios.md](./references/xslt-scenarios.md)
* **Verification Gate**: Fix any reported anti-hallucination error, engine mismatch, or missing namespace/parameter declaration before delivering the final `.xslt` file.
