# SAP S/4HANA API documentation: how to read it and what to take from it

Use this reference before designing or changing an iFlow that calls an SAP S/4HANA API (OData V2/V4 or SOAP). The official page for each API states **constraints that are not visible in the metadata** (for example how many documents a batch may change), so read it first instead of guessing from a failed call.

## 1. Where the documentation lives

| What | Where |
| :--- | :--- |
| Reference of every released API, grouped by area (Sourcing and Procurement, Sales, Finance...) | SAP Help Portal, product *SAP S/4HANA*, guide *APIs for <area>* |
| Concepts shared by all APIs (inbound/outbound, sync/async, A2A/A2X/B2B, authentication, ETag, change sets) | SAP Help Portal, page *APIs on SAP Business Accelerator Hub* (section Enterprise Technology) |
| Interactive model, schema view and samples | SAP Business Accelerator Hub (`api.sap.com`), package `S4HANAOPAPI` |

Each API page has the same layout, so you can scan it quickly: service name and service group, entities (with a link per entity), response codes, **Constraints**, authentication and a link to the Hub. Each entity page lists its properties with a *Necessity* column such as `Read-only`, `Filled automatically (for Create)`, `Mandatory (for Create)`, `Optional (for Update)`. That column tells you which fields may be sent in a PATCH and which are rejected.

## 2. Reading the Help Portal without a browser

The portal is a single-page application: fetching the HTML returns an empty shell. The JSON services behind it can be read with plain HTTPS requests (use `curl --compressed`):

1. Resolve the deliverable id of the guide. The two path segments of a Help URL (`/docs/<PRODUCT>/<DELIVERABLE_URL>/<TOPIC>.html`) are all that is needed:
   `https://help.sap.com/http.svc/deliverableMetadata?product_url=<PRODUCT>&deliverable_url=<DELIVERABLE_URL>&locale=en-US` returns `data.deliverable.id`.
2. Read a topic with that id:
   `https://help.sap.com/http.svc/pagecontent?deliverable_id=<ID>&file_path=<TOPIC>.html&locale=en-US` returns the page in `data.body` (HTML) and the whole table of contents in `data.deliverable.fullToc` (nested `t` = title, `u` = topic file, `c` = children).
3. Use the table of contents to find the subpages (service page, then one page per entity) and read them the same way.

Notes:
- The parameter for the topic is `file_path`; `topic_url` or `file_url` silently return the landing page instead of failing.
- In a cloud session the host `help.sap.com` has to be allowed in the environment network settings, otherwise the name does not resolve.
- Strip the HTML to text before reading and quote only what you need; do not paste whole pages into the repository.

## 3. Concepts that apply to every API

- **OData is synchronous, SOAP is message based.** Use OData when the caller needs the answer in the same HTTP call; SOAP acknowledges receipt and the real response comes later in a separate message.
- **Service categories.** A2A exchanges business data between systems of one company, A2X serves an unspecified client (messages carry texts and codes for UIs), B2B exchanges documents between companies.
- **Authentication.** Each API lists what it supports: Basic, X.509, OAuth 2.0 or SAML. Check the API page rather than assuming.
- **ETag and optimistic locking.** A modifying request has to carry the ETag received earlier in `If-Match`; the server rejects it when the record changed. `If-Match: *` is accepted and skips the comparison (last write wins).
- **Change sets.** One `$batch` may contain several change sets and each change set several operations, but an API can restrict what a change set may hold (see its Constraints section).
- **Response codes.** Typical service responses are 200 (read), 201 (created) and 204 (success without content). A `$batch` answers 200 for the envelope and reports the status of each part inside the body.

## 4. Index of the Sourcing and Procurement APIs

The guide *APIs for Sourcing and Procurement* groups the services below (OData V2, OData V4 or SOAP depending on the area; some areas also publish business events): Central Purchase Contract, Central RFQ, Central Supplier Quotation, Goods Receipt, Organizational and Other Data, Pricing, Product Sourcing, Purchase Contract, Purchase Order, Purchase Requisition / Shopping Cart, Purchase Scheduling Agreement, Purchasing Category, Purchasing Info Record, Purchasing Source List, Quota Arrangement, Request for Quotation, Service Entry Sheet, Supplier, **Supplier Confirmation**, Supplier Invoice, Supplier Quotation. Where both versions exist, the V2 page is marked deprecated and the V4 page is the one to use for new work.

## 5. Worked example: Supplier Confirmation (OData V4)

Read from the official pages; use it as a template for what to look for in any other API.

- **Entities** (service `SupplierConfirmation`, group `API_SUPPLIERCONFIRMATION`, repository `srvd_a2x`, version `0001`): header, item and line. The line is the only level that holds delivery date and confirmed quantity.
- **Keys.** The key of each level is composed (header number; header plus item; header plus item plus line) and the numbers are assigned by the system (`Read-only`, filled automatically on create). They are internal numbers, not the purchase order item number, so they have to be read before an update.
- **Update necessity.** For a line, delivery date, confirmed quantity and order quantity unit are optional on update; the reference purchase order of the header is read-only on update; the reference purchase order item of an item is optional on update.
- **Constraints worth designing around:**
  - One supplier confirmation can be created, changed or deleted per POST, PATCH or DELETE.
  - In a batch, **one supplier confirmation per change set**, and **multiple changes of the same confirmation must be done in a single change set**. Confirmations of different purchase orders go in separate change sets. Changes of several partial confirmations in one batch are not supported.
  - A confirmation cannot be created without items, and cannot be created for blocked or deleted purchase order items.
  - A confirmation in approval (workflow) cannot be changed; some fields may be read-only depending on the business context and then an error message is returned.
  - Mass processing is not supported.
- **Consequences for an iFlow:** look up the existing document first, read the internal keys with a GET by key, update line by line with named-key URIs, and put all those PATCH parts in one change set. See Pattern F in `skills/sap-cpi-groovy-generator/references/canonical-patterns.md`.
