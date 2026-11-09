# Guía Práctica de Flujos de Trabajo (`WORKFLOWS_GUIDE.md`)

Esta guía muestra cómo combinar las **Skills de IA** y los **scripts CLI** en escenarios habituales de proyectos de integración con SAP Cloud Integration (SAP CPI).

---

## Escenario 1: Auditar un iFlow existente y generar su Documentación Técnica

Cuando recibes un paquete `.zip` exportado de SAP CPI y necesitas evaluar su calidad arquitectónica y documentarlo:

### Paso 1: Inspeccionar el paquete `.zip`, generar el PDF de auditoría y autorremediar hallazgos
```bash
# 1. Auditar y generar informe PDF con el resumen de hallazgos
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Order_Replication.zip \
  --pdf ./Informe_Auditoria_Order_Replication.pdf \
  --extract-to ./extracted_iflow

# 2. Aplicar las correcciones elegidas por el usuario (ej. manifest, https, timeouts, streaming, csrf)
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Order_Replication.zip \
  --remediate manifest,https,timeouts,streaming \
  --out ./Order_Replication_Corregido.zip
```
Este flujo genera el resumen ejecutivo en PDF con el inventario y los hallazgos agrupados por categoría (seguridad, fiabilidad, rendimiento, Groovy y paquete) con tablas y matriz de severidad, y permite generar un nuevo `.zip` corregido aplicando únicamente los cambios confirmados por el usuario.

### Paso 2: Auditar los scripts Groovy extraídos
```bash
node skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs ./extracted_iflow/src/main/resources/script/ProcessOrder.groovy
```
Obtendrás el `Score de Calidad Original (0-100)` y las líneas exactas donde existan riesgos de OOM, XXE o incompatibilidades con *Upgrade Readiness*.

### Paso 3: Extraer topología y validar la Documentación Técnica (PDF de 10 secciones, Word editable con `--docx` y Markdown de 8)
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

---

## Escenario 5: Clonar y Adaptar una Integración de Referencia (`.zip`) según una Nueva Especificación API

Cuando dispones de una integración funcional en producción (uno o varios iFlows `.zip` + una `ScriptCollection.zip`) y necesitas crear nuevas integraciones o adaptar las existentes a partir de un documento de especificación técnica (PDF, Markdown u OpenAPI) sin exponer datos privados:

### Paso 1: Inspeccionar el paquete de referencia (modo seguro sin exponer `.prop`)
```bash
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./Paquete_Referencia.zip
```
El inspector detecta automáticamente los `.zip` anidados, identifica el tipo de cada bundle (`IntegrationFlow` vs `ScriptCollection`), lista los scripts invocados y redacta los valores sensibles de `.prop` como `[REDACTED]`.

### Paso 2: Generar y validar en lote los nuevos scripts de la Script Collection
Tras resolver cualquier ambigüedad funcional de la especificación (prioridad de campos alternativos, herencia de entidades padre o puntos abiertos), valida toda la carpeta de scripts Groovy en un solo comando:
```bash
node skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs ./scripts_nuevos --strict
```

### Paso 3: Clonar los iFlows y actualizar la Script Collection
```bash
# Clonar el iFlow de referencia cambiando su identificador OSGi, scripts asociados y ruta XPath del Splitter
node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
  --source ./Flujo_Origen.zip \
  --target-name Flujo_Nueva_Entidad_v1 \
  --out ./dist/Flujo_Nueva_Entidad_v1.zip \
  --replace ScriptOrigen.groovy=ScriptNuevaEntidad.groovy \
  --xpath //items=//nuevosItems

# Inyectar los nuevos scripts validados dentro de la Script Collection existente
node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
  --update-sc ./SC_Origen.zip \
  --scripts-dir ./scripts_nuevos \
  --out ./dist/SC_Actualizada.zip \
  --strict

# Inyectar recursos sueltos (.xsd, .mmap, .xsl, .wsdl) en un iFlow existente
node skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs \
  --source ./dist/Flujo_Nueva_Entidad_v1.zip \
  --add-resource ./EsquemaDestino.xsd \
  --add-resource ./MM_Transformacion.mmap \
  --out ./dist/Flujo_Nueva_Entidad_v1.zip
```

---

## Escenario 6: Generar Archivos Sueltos (`.xsd` y Graphical Message Mapping `.mmap`)

Cuando solo necesitas generar y validar un esquema `.xsd` o un mapeo gráfico `.mmap` (`<xiObj>`) sin reconstruir todo el proyecto:

```bash
# 1. Inferir un XSD tolerante (minOccurs="0" nillable="true") desde muestras JSON
node skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs \
  --infer ./muestra.json \
  --root OrderEnvelope --tolerant \
  --out ./OrderEnvelope.xsd

# 2. Generar y validar un Graphical Message Mapping (.mmap) que conecta dos XSDs
node skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs \
  --source-xsd OrderEnvelope.xsd:OrderEnvelope \
  --target-xsd ErpOrder.xsd:ErpOrder \
  --map "/ErpOrder/Header/OrderId=/OrderEnvelope/id" \
  --const "/ErpOrder/Header/SourceSystem=SAP-CPI" \
  --header "/ErpOrder/Header/HttpMethod=CamelHttpMethod" \
  --property "/ErpOrder/Header/CorrelationId=SAP_MplCorrelationId" \
  --out ./MM_Order_To_Erp.mmap
```

---

## Escenario 7: Simular un Graphical Message Mapping `.mmap` Localmente

Cuando deseas verificar que un mapeo `.mmap` transforma correctamente un payload de prueba antes de desplegarlo en el tenant de CPI:

```bash
# Simular ejecución con payload XML y cabeceras simuladas
node skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs \
  --mmap ./MM_Order_To_Erp.mmap \
  --payload ./test_order.xml \
  --header CamelHttpMethod=POST \
  --prop SAP_MplCorrelationId=CORR-99812 \
  --out ./test_result.xml

# O con payload JSON de entrada:
node skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs \
  --mmap ./MM_Order_To_Erp.mmap \
  --payload ./test_order.json \
  --json
```

---

## Escenario 8: Comparar Semánticamente dos Versiones de un iFlow y Generar PDF

Para revisiones de código (pull requests / code reviews) o validaciones previas a paso a producción:

```bash
# Comparar bundle v1 y bundle v2 remediado
node skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs \
  ./IF_Legacy_v1.zip \
  ./IF_Remediado_v2.zip \
  --pdf ./Informe_Comparativa_Diff.pdf
```
El reporte PDF incluirá la evolución del Score de cumplimiento, los cambios en parámetros de despliegue (`parameters.prop`), las adiciones/sustituciones de scripts y la resolución de vulnerabilidades de seguridad.

---

## Escenario 9: Exportar Clientes de Pruebas Postman v2.1 y Contratos OpenAPI 3.0

Para facilitar las pruebas de integración por parte del equipo de front-end, QA o sistemas consumidores:

```bash
node skills/sap-cpi-architect/scripts/export-api-client.mjs \
  ./IF_SyncPedidosB2B_S4HANA.zip \
  --out-dir ./dist/api_clients \
  --base-url https://my-tenant.cpi.example.test
```
Generará:
- `IF_SyncPedidosB2B_S4HANA.postman_collection.json` con pre-request scripts para obtención transparente de token CSRF (`x-csrf-token`).
- `IF_SyncPedidosB2B_S4HANA.openapi.json` con endpoints y contratos tipados.

---

## Escenario 10: Crear un Paquete OSGi de Value Mapping desde CSV o JSON

Para parametrizar correspondencias entre sistemas (por ejemplo, códigos de estado o códigos de país CRM a S/4HANA):

```bash
# Crear el bundle Value Mapping desde un CSV
node skills/sap-cpi-architect/scripts/build-value-mapping.mjs \
  ./mapeo_estados.csv \
  --name VM_OrderStatuses_S4 \
  --out ./dist/VM_OrderStatuses_S4.zip
```
El archivo `.zip` resultante estará listo para ser importado directamente en SAP Integration Suite con su naturaleza OSGi, metadatos y `value_mapping.xml`.

---

## Escenario 11: Trabajar con un iFlow Real sin Exponer Datos Privados (Limpiar → Trabajar → Restaurar)

Cuando compartes con la IA una exportación real de tu tenant (endpoints, alias de credenciales, parámetros externalizados, nombres de cliente), el agente pregunta primero si quieres limpiarla ([`rules/sap-cpi-privacy-sanitize.md`](../rules/sap-cpi-privacy-sanitize.md)).

```bash
# 1. Limpiar uno o varios bundles con un mapa compartido (los nombres de cliente/proyecto van en --terms)
node skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs ./export/FlowA.zip ./export/FlowB.zip \
  --out-dir ./work --terms ClienteDemo,ProyectoDemo

# 2. Trabajar solo sobre las copias limpias (auditar, editar Groovy/XSD/XSLT/.iflw manteniendo los alias)
node skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs ./work/FlowA.sanitized.zip

# 3. Restaurar los valores reales antes de importar en SAP CPI
node skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs --restore ./work/FlowA.sanitized.zip \
  --map ./work/sanitize-map.json --out ./dist/FlowA.zip
```

- La IA **nunca** lee el mapa (`sanitize-map.json` / `*.sanitize-map.json`); está ignorado por Git junto con `*.sanitized.zip` y `*.restored.zip`.
- Mientras quede algún alias, el inspector reporta `SANITIZED-001` (CRÍTICO) y el empaquetador se niega a generar el bundle.
- Para comprobar que la limpieza no deja nada sin cubrir, simula antes con `--check` (solo recuentos, no escribe nada) y revisa los recuentos; los nombres propios en texto libre solo se ocultan si están en `--terms`.
