# Regla de Privacidad: Limpieza Reversible de Bundles SAP CPI

Esta regla aplica siempre que el usuario te pase un `.zip`, `.iflw` o una Script Collection de SAP CPI que **no** hayas generado tú (exportaciones reales de un tenant).

## 1. Pregunta antes de leer

Antes de abrir, extraer o inspeccionar el contenido de un bundle real, pregunta **una sola vez** al usuario:

> Este bundle puede contener endpoints, alias de credenciales, valores de `parameters.prop` o nombres de cliente. ¿Quieres que lo limpie antes de leerlo?
> - **Sí, limpiar** (recomendado): creo una copia `.sanitized.zip` con alias reversibles y solo trabajo sobre ella.
> - **No**: lo leo tal cual (los `.prop` siguen redactados).
> - **Limpiar siempre**: no vuelvo a preguntar en esta sesión.

Pregunta también si hay **nombres de cliente o proyecto** que deban ocultarse (`--terms`). Los nombres escritos en texto libre solo se sustituyen si están en esa lista.

No preguntes con bundles generados por las skills, con `--demo` ni cuando el usuario ya contestó "Limpiar siempre".

## 2. Cómo limpiar

```bash
node skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs <in.zip...> --out-dir <carpeta> [--terms Cliente,Proyecto] [--drop-samples]
```

O vía MCP: `cpi_sanitize_zip` (`filePaths`, `outDir`, `terms`). Varios zips en una misma llamada comparten un mapa, así que el mismo valor recibe el mismo alias en todos.

- Trabaja **solo** con los `.sanitized.zip`. Los alias (`host-001.sanitized.invalid`, `SANITIZED_PARAM_001`, `urn:sanitized:ns-001`, `198.51.100.N`…) son sintácticamente válidos: puedes editar Groovy, XSD, XSLT e `.iflw` manteniéndolos tal cual.
- **Nunca** leas, imprimas ni resumas el mapa (`*.sanitize-map.json`, o `sanitize-map.json` con `--out-dir`): contiene los valores originales. Es solo local y está en `.gitignore`.
- No inventes alias nuevos con el formato `SANITIZED_*`: la restauración los rechaza.

## 3. Antes de importar en SAP CPI

Un bundle con alias **fallará** en el tenant. El inspector lo marca como `SANITIZED-001` (CRÍTICO) y `build-cpi-package.mjs` se niega a empaquetarlo. Indica siempre al usuario que restaure:

```bash
node skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs --restore <limpio.zip> --map <mapa.json> --out <final.zip>
```

O vía MCP: `cpi_restore_zip`. La restauración vuelve a poner los valores reales también en los archivos que hayas modificado, re-añade las muestras retiradas con `--drop-samples` y avisa si algún alias desapareció.

## 4. Límites

- Detecta URLs, hosts, emails, IPv4, alias de credenciales en `.iflw`, valores de `.prop` (y su reutilización en otros archivos), PEM, claves AWS, JWT, tokens Bearer, asignaciones de `password`/`secret`/`token`, URNs privados y los términos indicados.
- No detecta nombres propios en texto libre que no estén en `--terms`. Revisa los recuentos del informe.
- Los metadatos estándar del adaptador (`cmdVariantUri`, `Vendor`) y los namespaces estándar (W3C, OMG, SAP, `xml.org`…) no se tocan.
