# Directrices Oficiales de Esquemas XSD 1.0 para SAP CPI (Type System Guidelines)

## 1. Declaración Estándar y Namespaces
- Usa siempre `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">`.
- **Regla Anti-Namespace Prefix Conflict**: Si defines `targetNamespace="http://..."`, es **obligatorio** declarar también un prefijo para ese mismo namespace (p. ej. `xmlns:ns0="http://..."`). De lo contrario, el diseñador gráfico de *Message Mapping* en SAP CPI fallará al resolver referencias de tipos o elementos raíz.

## 2. Compatibilidad con el Diseñador Gráfico de Message Mapping
- **Elemento Raíz Único**: Define un único `<xsd:element name="NombreRaiz">` en el nivel superior del esquema.
- **Orden Determinista**: Utiliza siempre `<xsd:sequence>` dentro de `<xsd:complexType>`.
- **Prohibición de `<xsd:all>`**: El constructo `<xsd:all>` no está soportado por el motor gráfico de mapeo de SAP CPI en estructuras anidadas.
- **Límite de Nodos**: Mantén el esquema por debajo de los **20.000 nodos** del Type System de CPI.

## 3. Inferencia de Tipos Canónicos W3C
- Fechas ISO (`YYYY-MM-DD`): `xsd:date`
- Timestamps (`YYYY-MM-DDTHH:mm:ss`): `xsd:dateTime`
- Importes monetarios y decimales: `xsd:decimal`
- Enteros y contadores: `xsd:integer`
- Booleanos (`true`/`false`): `xsd:boolean`
- Textos e identificadores alfanuméricos: `xsd:string`

## 4. Fusión Multi-Muestra (Multi-Payload Merge)
- Al recibir 2 o más payloads de ejemplo (p. ej., un pedido nacional sin aduanas y un pedido internacional con bloque de aduanas), el esquema XSD debe incluir la unión de todos los campos, asignando `minOccurs="0"` a aquellos campos que no aparezcan en el 100% de las muestras.
- Los arrays se modelan con `minOccurs="0" maxOccurs="unbounded"`.
