# Escenarios Canónicos y Funciones de Extensión XSLT en SAP CPI

## 1. Acceso Oficial a Cabeceras y Propiedades del Exchange
Para leer o fijar Headers y Exchange Properties desde XSLT en SAP Cloud Integration:
- **Lectura entrante sin extensiones (Recomendado por SAP)**: Declara `<xsl:param name="NombreHeaderOPropiedad" select="'VALOR_POR_DEFECTO'"/>` a nivel raíz. SAP CPI inyecta automáticamente cualquier Header o Exchange Property cuyo nombre coincida con el parámetro.
- **Escritura/Lectura dinámica vía Funciones de Extensión**:
  - **Namespaces soportados**: `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` o `xmlns:sapci="http://sap.com/it/"`
  - **Parámetro inyectado**: `<xsl:param name="exchange"/>`
  - **Funciones**:
    - `cpi:getHeader($exchange, 'HeaderName')`
    - `<xsl:value-of select="cpi:setHeader($exchange, 'HeaderName', 'Valor')"/>`
    - `cpi:getProperty($exchange, 'PropertyName')`
    - `<xsl:value-of select="cpi:setProperty($exchange, 'PropertyName', 'Valor')"/>`
- **Conversión JSON a XML Nativa en XSLT 3.0 (Saxon-HE)**:
  - Usa `version="3.0"` y `json-to-xml(.)` con `xpath-default-namespace="http://www.w3.org/2005/xpath-functions"`.
  - Para transformaciones pass-through en XSLT 3.0 usa `<xsl:mode on-no-match="shallow-copy"/>` y, en archivos masivos, `<xsl:mode streamable="yes"/>`.

---

## 2. Escenarios Preconfigurados

### Escenario 1: XML Plano a Jerárquico (XSLT 2.0 - Saxon-HE)
Agrupa registros planos `<Record>` por `OrderId` usando `<xsl:for-each-group select="//Record" group-by="OrderId">` y `current-grouping-key()`.

### Escenario 2: Purga Recursiva de Nodos Vacíos (XSLT 1.0 - Apache Xalan)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:output method="xml" encoding="UTF-8" indent="no"/>
    <xsl:strip-space elements="*"/>

    <xsl:template match="node()|@*">
        <xsl:copy>
            <xsl:apply-templates select="node()|@*"/>
        </xsl:copy>
    </xsl:template>

    <xsl:template match="*[not(@*) and not(*) and not(text()[normalize-space()])]"/>
</xsl:stylesheet>
```

### Escenario 3: Normalizador de Namespaces (XSLT 1.0 / 2.0)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:output method="xml" encoding="UTF-8" indent="no"/>
    <xsl:strip-space elements="*"/>

    <xsl:template match="*">
        <xsl:element name="{local-name()}">
            <xsl:apply-templates select="@*|node()"/>
        </xsl:element>
    </xsl:template>

    <xsl:template match="@*">
        <xsl:attribute name="{local-name()}">
            <xsl:value-of select="."/>
        </xsl:attribute>
    </xsl:template>
</xsl:stylesheet>
```
