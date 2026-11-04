# Reglas de Auditoría de Arquitectura SAP CPI (.iflw / BPMN 2.0)

## 1. Ausencia de Exception Subprocess (Severidad: CRÍTICA, -30 pts)
- **Regla**: Todo proceso de integración (`<bpmn2:process>`) debe contar con un `<bpmn2:subProcess triggeredByEvent="true">` y `ifl:type="ExceptionSubProcess"`.
- **Impacto**: Sin este subproceso, cualquier excepción detiene el flujo abruptamente sin registro enriquecido en el MPL ni notificación/compensación hacia los sistemas llamadores.

## 2. Canales Inseguros sin Cifrado TLS (Severidad: CRÍTICA, -30 pts c/u)
- **Regla**: Todas las propiedades de adaptadores (`address`, `httpAddress`, `url`) deben utilizar `https://` o cifrado TLS a nivel de transporte.
- **Impacto**: La transmisión en texto plano (`http://`) expone payloads corporativos y cabeceras de autenticación en tránsito.

## 3. Falta de Externalización en Parámetros Sensibles (Severidad: ALTA, -15 pts c/u)
- **Regla**: Ninguna URL de servidor externo, credencial, token o alias debe incrustarse en duro en el XML del flujo. Debe utilizarse la sintaxis de parámetros externalizados de SAP CPI: `{{NombreParametro}}`.
- **Impacto**: Impide el transporte limpio entre entornos (DEV -> QAS -> PRD) sin editar manualmente el artefacto y expone datos de infraestructura.

## 4. Adaptadores Síncronos Request-Reply sin Timeout Explícito (Severidad: MEDIA, -5 pts c/u)
- **Regla**: Todo `<bpmn2:serviceTask>` o `<bpmn2:callActivity>` con `activityType="ExternalCall"` debe declarar un timeout explícito razonable (p. ej., `60000` ms).
- **Impacto**: Si el sistema destino no responde, los hilos worker del tenant de SAP CPI quedan bloqueados indefinidamente causando denegación de servicio.

## 5. Content Modifiers que Copian `${body}` a Exchange Property (Severidad: CRÍTICA, -30 pts c/u)
- **Regla**: Evitar asignar `${body}` o `${in.body}` en una Exchange Property dentro de un Content Modifier.
- **Impacto**: Duplica el payload completo en la memoria Heap de la JVM durante toda la vida del Exchange, provocando `OutOfMemoryError: Java heap space` con mensajes medianos o grandes.

## 6. Validez de Estructura OSGi y `META-INF/MANIFEST.MF` (Severidad: CRÍTICA, -40 pts c/u)
- **Regla**: `META-INF/MANIFEST.MF` y `.project` deben estar ubicados directamente en la raíz del `.zip` (`META-INF/MANIFEST.MF`, nunca dentro de una subcarpeta como `NombreFlujo/META-INF/MANIFEST.MF`), y ninguna línea del `MANIFEST.MF` puede superar los 72 bytes UTF-8.
- **Impacto**: Si `META-INF/MANIFEST.MF` está anidado en una carpeta intermedia o supera los 72 bytes por línea, SAP Cloud Integration rechaza la importación con el error `Upload the artifact failed. The project must contain a valid manifest file`.

## 7. Reglas Adicionales de Gobernanza SAP CPI y CPILint (Severidad: ADVISORY)
- **Streaming en Splitters (`splittersWithoutStreaming`)**: Los pasos `General Splitter` e `Iterating Splitter` deben activar `<key>streaming</key><value>true</value>` para procesar lotes XML/JSON por fragmentos sin cargar todo el árbol DOM en memoria.
- **Ruta por Defecto en Routers (`routersWithoutDefaultRoute`)**: Todo `<bpmn2:exclusiveGateway>` debe definir una ruta `default` para evitar errores en tiempo de ejecución cuando un mensaje no cumple ninguna condición.
- **Autenticación y Protección CSRF (`CleartextBasicAuth` / `CsrfProtectionRequired`)**: Se recomienda sustituir `BasicAuthentication` por OAuth2 o Client Certificate, y mantener activa la protección CSRF (`xsrfProtection=1`) en endpoints modificadores HTTP/HTTPS.
