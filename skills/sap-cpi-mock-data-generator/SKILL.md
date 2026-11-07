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

> **Division of work (read this first).** The *agent* writes the payloads (Steps 1–2). The script `pack-mock-suite.mjs` does **not** generate data: it only **validates and packages** what the agent wrote. It checks:
> - JSON syntax (`JSON.parse`) and XML well-formedness (real parser, not a regex). Only `json` and `xml` formats are accepted; `csv` or any other format is an error.
> - Correlation of business keys between contracts, example by example (keys are matched case-insensitively and ignoring `_`, `-`, `.`; XML attributes and leaf elements count; `"1001"` and `1001` are equal).
> - Duplicate contract names and contracts with a different number of examples.
>
> It does **not** check the content rules of Step 1 (`count` 1–10, IDoc `EDI_DC40` control record, OData `$batch` changesets, NIF/CIF formats, statuses). Those are the agent's responsibility: review them yourself before packaging and tell the user they were not machine-verified.

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
node ./scripts/pack-mock-suite.mjs <input-batch.txt-or-suite.json> [--out cpi_mock_suite.zip] [--extract-dir ./mock-output] [--correlateKey customerId] [--strict] [--timestamp] [--json]
```

| Flag | Effect |
|---|---|
| `--correlateKey <k>` (alias `--correlate-key`) | Business key(s) to compare across contracts (comma list: `orderId,customerId`). |
| `--strict` | Correlation mismatches and different example counts become **errors** (default: warnings). Use it in CI and whenever the user needs real E2E data. |
| `--timestamp` | Writes the generation date into `README_SUITE.txt` and `mock-suite-index.json`. Without it the ZIP is **byte-for-byte reproducible** (fixed entry dates; `SOURCE_DATE_EPOCH` is honoured). |
| `--json` | Machine-readable result (`valid`, `errors`, `warnings`, `correlationMismatches`, `sizeBytes`, `written`). |
| `--demo` | Runs the built-in two-contract example. |

Exit codes: `0` valid and written, `1` invalid input or validation errors (**no ZIP or folder is written**), `2` unknown flag or missing flag value. MCP: `cpi_pack_mock_suite` accepts the same `strict` and `timestamp` options.

* Validator & packager script: [pack-mock-suite.mjs](./scripts/pack-mock-suite.mjs)
* Correlation reference: [correlation-rules.md](./references/correlation-rules.md)
* **Verification Gate**: Every generated JSON/XML sample must pass syntax validation (`valid: true`), correlation keys must match across contracts (run with `--strict` so a mismatch fails), and the `.zip` archive (with `README_SUITE.txt` and `mock-suite-index.json`) is written to disk. If the script reports warnings without `--strict`, fix them or explain them to the user; never present a suite with correlation mismatches as E2E-ready.


## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un error o mejora en la generación de payloads de prueba o correlaciones E2E en SAP CPI, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente el patrón estructural genérico, sin guardar jamás datos reales de proyectos privados o clientes.
2. **Codificar en el Script CLI**: Actualizar `./scripts/pack-mock-suite.mjs` para cubrir el nuevo caso.
3. **Actualizar Documentación y Lecciones**: Documentar la mejora en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
