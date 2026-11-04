---
name: sap-cpi-xsd-studio
description: >-
  Use this skill when the user wants to infer, generate, or validate W3C XSD 1.0 schemas
  from single or multiple JSON/XML sample payloads for SAP Cloud Integration (CPI) Message
  Mapping and XML Validator 2.0.
---

# SAP CPI XSD Schema Studio

Infers and validates canonical W3C XSD 1.0 schemas from single or multiple JSON/XML payloads, enforcing 100% compatibility with SAP Cloud Integration's graphical **Message Mapping** tool and **XML Validator 2.0**.

## Workflow Steps

### Step 1: Gather Schema Metadata & Sample Payloads
1. **Schema Parameters**:
   - `rootElement` (e.g., `SalesOrder`, `BusinessPartner`, `Invoice`)
   - `targetNamespace` (e.g., `http://sap.com/xi/SD/SalesOrder` or no-namespace)
   - `namespacePrefix` (default `ns0` — required whenever `targetNamespace` is set to avoid *Namespace Prefix Conflict* in CPI Message Mapping)
   - `elementFormDefault` (`qualified` recommended by SAP)
2. **Multi-Payload Merging**:
   - When multiple JSON/XML samples are provided, merge all fields into a superset schema and mark fields that do not appear in every sample (or are nullable) with `minOccurs="0"`.

### Step 2: Infer or Author the XSD 1.0 Schema
You can generate a deterministic XSD 1.0 directly from JSON sample files (or refine it with custom constraints) using `validate-xsd.mjs`:

```bash
node ./scripts/validate-xsd.mjs --infer <sample1.json> [<sample2.json> ...] --root SalesOrder --ns "http://sap.com/xi/SD/SalesOrder" --prefix ns0 --out SalesOrder.xsd
```

Ensure the schema obeys all SAP CPI Type System rules in [xsd-guidelines.md](./references/xsd-guidelines.md):
- Use `<xsd:sequence>` for complex types (**never** `<xsd:all>`).
- Define a **single** top-level root `<xsd:element>`.
- Use canonical types: `xsd:date` (`YYYY-MM-DD`), `xsd:dateTime` (`YYYY-MM-DDTHH:mm:ss...`), `xsd:decimal`, `xsd:integer`, `xsd:boolean`, `xsd:string`.
- Keep total `<xsd:element>` + `<xsd:attribute>` nodes under the 20,000-node CPI Type System limit.

### Step 3: Validate the XSD Schema
Run the validator against the `.xsd` file:

```bash
node ./scripts/validate-xsd.mjs <path-to-schema.xsd> [--json]
```

* Inference & validator script: [validate-xsd.mjs](./scripts/validate-xsd.mjs)
* Reference guidelines: [xsd-guidelines.md](./references/xsd-guidelines.md)
* **Verification Gate**: Must pass with `valid: true` and 0 errors before delivering the `.xsd` schema.
