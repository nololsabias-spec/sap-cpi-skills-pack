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

### Step 0: Interactive Discovery & Clarification Gate (Ask Before Assuming)
Before inferring or writing the W3C XSD 1.0 schema, check if key schema constraints are missing. **Ask brief clarifying questions if needed**:
1. **Sample Payloads & Cardinality**: If the user only provided a single sample payload, ask which fields are optional (`minOccurs="0"`), which arrays can repeat (`maxOccurs="unbounded"`), or if they have a second partial sample to automatically infer optionality.
2. **Target Namespace & Root Element**: Ask for the desired root element name (e.g., `SalesOrderRequest`), `targetNamespace` URI, and prefix (`ns0`), or confirm if it should be a no-namespace schema.
3. **Strict Data Type Constraints**: Ask if specific string fields require `<xsd:restriction>` facets (`maxLength`, `pattern`, `enumeration` for SAP codes like `BUKRS`, `KUNNR`, `WAERS`, or decimal `totalDigits`/`fractionDigits`).

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
- Define a **single** top-level root `<xsd:element>`. When an iFlow converts JSON to XML before validation or mapping, ensure the **Add XML Root Element** option is enabled on the *JSON to XML Converter* step so the root tag matches the XSD root element.
- **`minOccurs="0"` vs. `nillable="true"` (SAP Note 2624922 & JSON-to-XML Compatibility)**:
  - `nillable="true"` alone (`minOccurs="1"` by default) requires the XML tag to be physically present with `xsi:nil="true"`. Because SAP CPI's standard *JSON to XML Converter* either omits `null` JSON properties or renders `<field/>` without `xsi:nil="true"`, always combine `minOccurs="0" nillable="true"` for nullable fields so neither the XML Validator nor Message Mapping fails with *"Queue has not enough values in context"*.
- **Namespace Qualification Alignment (`elementFormDefault`)**:
  - If the XSD declares `targetNamespace` and `elementFormDefault="qualified"`, runtime XML payloads must include namespace prefixes (or configure Runtime Namespace Mapping in the iFlow); if mapping flat/prefix-less intermediate XML produced by a JSON-to-XML Converter, use `elementFormDefault="unqualified"` or omit `targetNamespace`.
- Use canonical types: `xsd:date` (`YYYY-MM-DD`), `xsd:dateTime` (`YYYY-MM-DDTHH:mm:ss...`), `xsd:decimal`, `xsd:integer`, `xsd:boolean`, `xsd:string`.
- Keep total `<xsd:element>` + `<xsd:attribute>` nodes under the 20,000-node CPI Type System limit.
- **Reference Patterns for Shared Handlers & Observability Schemas**:
  - **Tolerant Handler Envelope Pattern**: When designing an input XSD for a shared/reusable handler iFlow (e.g., a central `ProcessDirect` Error/Alert Handler called by multiple iFlows), declare all child elements as `minOccurs="0" nillable="true"`. This ensures that callers emitting partial envelopes (e.g., omitting `UserAgent` or `Body`) never cause downstream Content Modifiers or Message Mappings (`.mmap`) to fail.
  - **Unified Multi-Platform Cloud Logging / OpenSearch Schema Pattern**: When designing an output XSD for central observability shared across **SAP Integration Suite (CPI)** and **SAP API Management (APIM)**:
    1. Define a common top-level envelope (`timestamp`, `duration_ms`, `level`, `msg`, `source`, `environment`, `package`, `artifact_name`, `step_name`, `request`, `response`, and flat MPL correlation IDs `original_sap_messageprocessinglogid`, `sap_messageprocessinglogid`, `sap_mplcorrelationid`, `sap_pregeneratedmplid`).
    2. Restrict `<request><headers>` to a **fixed subset of headers** (e.g., `user_agent`, `content_type`) to prevent *mapping explosion* in OpenSearch index templates.
    3. Isolate platform-specific fields inside optional sub-containers (`<integration_suite minOccurs="0">` vs `<apim minOccurs="0">`) and use `<xs:simpleType>` enumerations for `LogLevel` (`DEBUG|INFO|WARN|ERROR`) and `LogSource` (`integration-suite|api-manager`).

### Step 3: Validate the XSD Schema
Run the validator against the `.xsd` file:

```bash
node ./scripts/validate-xsd.mjs <path-to-schema.xsd> [--json]
```

* Inference & validator script: [validate-xsd.mjs](./scripts/validate-xsd.mjs)
* Reference guidelines: [xsd-guidelines.md](./references/xsd-guidelines.md)
* **Verification Gate**: Must pass with `valid: true` and 0 errors before delivering the `.xsd` schema.


## Protocolo de Aprendizaje Continuo (Self-Improving Harness)

Siempre que el usuario reporte un fallo de validación en Message Mapping o XML Validator 2.0 en SAP CPI o comparta esquemas `.xsd` de referencia, tras resolver su tarea inmediata debes aplicar automáticamente el ciclo de auto-mejora:
1. **Anonimizar (Zero Data Leakage)**: Extraer únicamente el patrón estructural W3C XSD 1.0 genérico, sin guardar jamás nombres de proyectos privados, clientes ni datos confidenciales.
2. **Codificar en el Script CLI**: Actualizar `./scripts/validate-xsd.mjs` para cubrir el nuevo caso.
3. **Actualizar Documentación y Lecciones**: Documentar la mejora en esta `SKILL.md`, en `docs/VALIDATION_RULES.md` y en `docs/LESSONS_LEARNED.md`.
4. **Verificar y Sincronizar**: Ejecutar `node verify-all.mjs` y `node setup-skills.mjs` para propagar el aprendizaje a `.agents/` y `.claude/`.
