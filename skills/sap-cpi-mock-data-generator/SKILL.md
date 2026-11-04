---
name: sap-cpi-mock-data-generator
description: >-
  Use this skill when the user wants to generate realistic SAP Cloud Integration (CPI / ERP)
  mock test data suites (single or multi-payload JSON/XML contracts), validate E2E foreign-key
  correlation across payloads (Request, Response, Lookup, Error), or package test data into a
  structured .zip suite.
---

# SAP CPI Multi-Payload Mock Data Generator Suite

Generates syntactically valid, realistic SAP BTP / ERP mock test payloads (JSON and XML) across one or multiple integration contracts, verifies E2E foreign-key correlation across contracts, and packages the test suite into an organized `.zip` archive with `README_SUITE.txt`.

## Workflow Steps

### Step 0: Interactive Discovery & Clarification Gate (Ask Before Assuming)
Before generating the mock test suite, check if the user's prompt defines the full test scenario. **If details are missing, ask brief clarifying questions first**:
1. **Contracts & Formats**: How many payloads/contracts are involved in the End-to-End flow (e.g., Inbound Request JSON, Lookup Response XML, Target S/4HANA OData Payload) and what are their structures or XSD/JSON samples?
2. **Cross-Contract Correlation Keys**: Which business identifiers must match across all contracts in each test case (e.g., `customerId`/`KUNNR`, `orderId`/`VBELN`, `companyCode`/`BUKRS`, `currency`)?
3. **Volume & Test Scenarios**: How many examples per contract are needed, and which specific edge cases or error scenarios (e.g., invalid tax IDs, negative quantities, special UTF-8 characters, missing mandatory fields) should be included?

### Step 1: Define Integration Contracts & Correlation Rules
1. **Contracts**: Identify each payload contract (`name`, `format` [`json` | `xml`], base schema/sample, `count` [1–10], and edge-case instructions such as Spanish NIF/CIF, zero/decimal boundary values, or varied order statuses `NEW`, `APPROVED`, `REJECTED`, `ON_HOLD`).
2. **Official SAP Payload Standards (IDoc `EDI_DC40`, OData `$batch` & SOAP)**:
   - **SAP IDoc XML (`EDI_DC40`)**: Always include the mandatory control record `<EDI_DC40 SEGMENT="1">` with `<TABNAM>EDI_DC40</TABNAM>`, `<DIRECT>` (`1` Outbound / `2` Inbound), `<IDOCTYP>` (e.g., `ORDERS05`), `<MESTYP>` (e.g., `ORDERS`), `<SNDPOR>`, `<SNDPRT>LS</SNDPRT>`, `<SNDPRN>`, `<RCVPOR>`, `<RCVPRT>LS</RCVPRT>`, and `<RCVPRN>` aligned with `WE20`/`BD54` partner profiles.
   - **OData V2/V4 `$batch` Payloads**: Group modifying operations (`POST`, `PUT`, `DELETE`) inside atomic `<batchChangeSet>` / `--changeset_<UUID>` blocks, while keeping `GET` queries in standalone `<batchQueryPart>` blocks (recommended chunk size: 50–100 records per batch).
3. **Cross-Contract Correlation (`correlateData`)**:
   - When generating for 2+ contracts (e.g., `Pedido Request` JSON + `Customer Lookup` XML), Example `#k` in every contract MUST share the exact same business identifiers (`customerId` / `CustomerID`, `orderId` / `OrderID`, `currency`, etc.) so the files can be used together in an End-to-End iFlow simulation.
   - See [correlation-rules.md](./references/correlation-rules.md) for the delimiter format and correlation checks.

### Step 2: Generate the Examples Using Canonical Delimiters
Format the generated output using:
```text
=== PAYLOAD: NombreContrato1 ===
=== EXAMPLE 1 ===
{ ... }
=== EXAMPLE 2 ===
{ ... }
=== PAYLOAD: NombreContrato2 ===
=== EXAMPLE 1 ===
<Root>...</Root>
```

### Step 3: Validate Syntax, Check E2E Correlation & Package `.ZIP`
Run `pack-mock-suite.mjs` on your generated batch file (or JSON suite file):

```bash
node ./scripts/pack-mock-suite.mjs <input-batch.txt-or-suite.json> [--out cpi_mock_suite.zip] [--extract-dir ./mock-output] [--correlateKey customerId]
```

* Validator & packager script: [pack-mock-suite.mjs](./scripts/pack-mock-suite.mjs)
* Correlation reference: [correlation-rules.md](./references/correlation-rules.md)
* **Verification Gate**: Every generated JSON/XML sample must pass syntax validation (`valid: true`), correlation keys must match across contracts, and the `.zip` archive (with `README_SUITE.txt`) is written to disk.
