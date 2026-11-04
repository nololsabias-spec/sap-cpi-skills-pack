# Guía Práctica de Flujos de Trabajo (`WORKFLOWS_GUIDE.md`)

Esta guía muestra cómo combinar las **Skills de IA** y los **scripts CLI** en escenarios habituales de proyectos de integración con SAP Cloud Integration (SAP CPI).

---

## Escenario 1: Auditar un iFlow existente y generar su Documentación Técnica

Cuando recibes un paquete `.zip` exportado de SAP CPI y necesitas evaluar su calidad arquitectónica y documentarlo:

### Paso 1: Inspeccionar el paquete `.zip` y auditar el `.iflw`
```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Order_Replication.zip --extract-to ./extracted_iflow
```
Este comando lista todos los recursos internos y señala si faltan `Exception Subprocess`, si hay canales HTTP sin TLS, timeouts ausentes o propiedades que almacenan `${body}`.

### Paso 2: Auditar los scripts Groovy extraídos
```bash
node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./extracted_iflow/src/main/resources/script/ProcessOrder.groovy
```
Obtendrás el `Score de Calidad Original (0-100)` y las líneas exactas donde existan riesgos de OOM, XXE o incompatibilidades con *Upgrade Readiness*.

### Paso 3: Extraer topología y validar la Documentación Técnica (8 Secciones)
```bash
node skills/sap-cpi-architect/scripts/extract-for-docs.mjs ./Order_Replication.zip --validate-doc ./Doc_Tecnica_Order_Replication.md
```

---

## Escenario 2: Refactorizar un Script Groovy Legacy hasta alcanzar `100/100`

Si tienes un script Groovy antiguo que usa `message.getBody(String)`, `new JsonSlurper()`, `new Date()` o `import groovy.json.*`:

1. **Ejecutar auditoría inicial:**
   ```bash
   node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./legacy.groovy
   ```
2. **Refactorizar el script** aplicando streaming (`Reader`), `JsonSlurperClassic`, `ZoneId.of("UTC")`, imports explícitos y adjuntos MPL condicionales.
3. **Verificar que la refactorización cumple el estándar `100/100`:**
   ```bash
   node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./legacy.groovy --refactored ./refactored.groovy
   ```
   El comando devolverá código de salida `0` únicamente si el script refactorizado alcanza `100/100` con `0` errores.

---

## Escenario 3: Inferir un Esquema XSD Multi-Muestra y Generar Datos Mock Correlacionados

Cuando construyes un Message Mapping a partir de ejemplos JSON de una API REST donde algunos campos son opcionales:

### Paso 1: Inferir y validar el esquema XSD combinando varias muestras JSON
```bash
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer ./payload_completo.json ./payload_parcial.json \
  --root InvoicePayload \
  --namespace "http://enterprise.com/cpi/invoice" \
  --out ./InvoicePayload.xsd
```
El motor detecta automáticamente qué campos faltan en `payload_parcial.json` y les asigna `minOccurs="0"`, validando además que el XSD resultante no contenga `<xsd:all>` ni conflictos de prefijos.

### Paso 2: Generar y empaquetar una batería de pruebas E2E (`.zip`)
```bash
node skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs \
  --spec ./mock-suite-spec.json \
  --out ./Invoice_Test_Suite.zip
```
El empaquetador verifica que los payloads de entrada y respuesta compartan los mismos IDs de negocio (`invoiceId`, `customerId`) y crea el paquete `.zip` con carpetas `ok/`, `edge/`, `error/` y `README_SUITE.txt`.

---

## Escenario 4: Construir un Paquete OSGi Dual (iFlow + Script Collection) desde Cero

Para empaquetar un Integration Flow junto con su Script Collection listos para importar en SAP Integration Suite:

1. Prepara el archivo de especificación JSON (`bundle-spec.json`) con la definición del iFlow (`iflowId`, `iflowXml`, `parametersProp`) y los scripts Groovy (`scriptCollectionId`, `scripts`).
2. Ejecuta el constructor OSGi:
   ```bash
   node skills/sap-cpi-architect/scripts/build-cpi-package.mjs \
     --spec ./bundle-spec.json \
     --out-dir ./dist
   ```
3. El script:
   - Audita el XML BPMN 2.0 (`.iflw`).
   - Valida cada script Groovy incluido en la colección.
   - Genera `dist/<IflowId>.zip`, `dist/<SC_IflowId>.zip` y `dist/Paquete_<IflowId>.zip` con sus `META-INF/MANIFEST.MF` y `.project` vinculados mediante `Provide-Capability` y `Require-Capability`.
