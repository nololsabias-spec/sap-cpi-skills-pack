# Reglas de Generación y Correlación E2E de Datos de Prueba (Mock Data Suite)

## 1. Formato de Delimitadores Estándar
- **Modo Simple (1 Contrato)**:
  ```text
  === EXAMPLE 1 ===
  { "orderId": "ORD-01" }
  === EXAMPLE 2 ===
  { "orderId": "ORD-02" }
  ```
- **Modo Lote Multi-Contrato (N Contratos)**:
  ```text
  === PAYLOAD: Pedido Request ===
  === EXAMPLE 1 ===
  { "orderId": "ORD-01", "customerId": "CUST-441" }
  === PAYLOAD: Customer Lookup ===
  === EXAMPLE 1 ===
  <CustomerMaster><CustomerID>CUST-441</CustomerID></CustomerMaster>
  ```

## 2. Regla de Correlación de Claves Foráneas (End-to-End)
Cuando `correlateData` está activo:
- El `EXAMPLE #k` del Contrato 1, del Contrato 2 y del Contrato N representan **el mismo escenario de negocio** viajando a través de los distintos pasos del iFlow (Request -> Enrichment Lookup -> S/4HANA Target -> Ack).
- Por tanto, las claves de negocio (`orderId`, `customerId`, `partnerId`, `invoiceNumber`, `kunnr`, `currency`) del `EXAMPLE #k` deben coincidir exactamente entre todos los contratos.

## 3. Variación Realista SAP / ERP
- **Clientes ES**: NIF/CIF válidos (`ESA12345678`, `ESB87654321`), códigos postales reales (`28001`–`28050`, `08001`–`08040`).
- **Casos Límite (Edge Cases)**: Importes con `0.00` o decimales de precisión (`1250.45`), cadenas con tildes/ñ/diéresis para verificar codificación UTF-8 en CPI.
- **Estados Variados**: `NEW`, `PENDING`, `APPROVED`, `REJECTED`, `ON_HOLD`.
