# Presets Oficiales de Expresiones Regulares y Camel Simple para SAP CPI

## 1. Router por `CamelHttpPath`
- **Componente**: `Router (Camel Simple)`
- **Campo**: `${header.CamelHttpPath}`
- **Patrón**: `^/api/v1/orders/\d+(\?.*)?$`
- **Expresión Camel Simple**: `${header.CamelHttpPath} regex '^/api/v1/orders/\d+(\?.*)?$'`
- **Muestra MATCH**: `/api/v1/orders/4500012345?expand=items`

## 2. Extracción por Grupos en Content Modifier
- **Componente**: `Content Modifier`
- **Campo**: `${header.InvoiceNumber}`
- **Patrón**: `^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$`
- **Expresión Camel Simple**: `${header.InvoiceNumber.replaceAll('^[A-Z]+-\d{4}-(\d+)-[A-Z]{2}$', '$1')}`
- **Muestra MATCH**: `INV-2024-99382-ES` -> `$1 = "99382"`

## 3. Código de Cliente SAP (`KUNNR`)
- **Componente**: `Router / Validator`
- **Campo**: `${header.CustomerId}`
- **Patrón**: `^\d{1,10}$`
- **Expresión Camel Simple**: `${header.CustomerId} regex '^\d{1,10}$'`
- **Muestra MATCH**: `0000123456`

## 4. Correo Corporativo RFC 5322 Simplificado
- **Componente**: `Router / Validator`
- **Campo**: `${property.RecipientEmail}`
- **Patrón**: `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`
- **Muestra MATCH**: `integration.suite@my-company.com`

## 5. Validador UUID v4 (Correlación / MPL)
- **Componente**: `Router / Validator`
- **Campo**: `${header.X-Correlation-ID}`
- **Patrón**: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`
- **Muestra MATCH**: `c9bf9e57-1685-4c89-bafb-ff5af830be8a`

## 6. Lista de Inclusión / Exclusión (`in` / `not in`) y Fechas con Zona Horaria
- **Alternativa oficial a `not in` en Router**: `${property.CountryCode} not regex '^(ES|PT|FR|IT)$'`
- **Timestamp con Zona Horaria en Content Modifier (sin Groovy)**: `${date-with-timezone:now:UTC:yyyy-MM-dd'T'HH:mm:ss'Z'}`
- **XPath resiliente a Namespaces en Content Modifier**: `//*[local-name()='OrderNumber']/text()` (extraer siempre a una Exchange Property tipada `java.lang.String` antes del Router).
