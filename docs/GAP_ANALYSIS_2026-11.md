# Análisis de Gaps y Mejoras — SAP CPI Skills Pack (noviembre 2026)

> Auditoría de solo lectura en dos fases:
> 1. **Análisis** con 5 agentes en paralelo (Groovy · ZIP/Architect · Studios XSD/XSLT/Regex/Mock · Infra MCP/Instalador/Docs · Novedades SAP 2025-2026).
> 2. **Verificación** con 4 agentes independientes: (a) reproducción de bugs con casos sintéticos, (b) runtime SAP contra el markdown oficial de SAP Help (`github.com/SAP-docs/btp-integration-suite`), (c) formatos de iFlow contra exportaciones reales públicas y el código de CPILint, (d) MCP/skills/IDEs contra las especificaciones oficiales y pruebas por stdio.
>
> No se ha leído ningún `.prop`.
>
> **Estado de implementación (2026-11-07):** todos los **P0 (§1.1–§1.6) están corregidos** (ver `LL-016`, `LL-017` y `LL-018` en `docs/LESSONS_LEARNED.md`); `node verify-all.mjs` → 16/16 PASS. De §3.5 también se corrigieron los nombres de scripts obsoletos, la versión de Groovy en `groovy-generator/SKILL.md` y la nota de Claude Desktop del README. P1, P2 y el resto de §3.4/§3.5 siguen pendientes. El plan de la base de pruebas (§3.4) está en [`docs/TEST_PLAN_PROMPT.md`](./TEST_PLAN_PROMPT.md).
>
> Estado de partida: `node verify-all.mjs` → 16/16 PASS, pero **solo ejecuta los `--demo` del camino feliz**; ninguno de los fallos de abajo lo detecta la suite.

**Leyenda de verificación:** ✅ CONFIRMADO (reproducido o con fuente oficial) · 🟡 PARCIAL (cierto con matices, ver nota) · ❌ FALSO (corregido en esta versión) · ❔ NO VERIFICABLE (sin fuente pública; se trata como recomendación, no como hecho).

---

## 0. Resumen ejecutivo

| Área | Hallazgo dominante | Verif. |
|---|---|---|
| **Arranque** | `isMain` con `new URL(import.meta.url).pathname` (sin `fileURLToPath`) → **19 ocurrencias (15 en `skills/`)**: los CLIs y el MCP server salen con exit 0 sin hacer nada si la ruta tiene espacios o acentos. `verify-all` sí falla de forma visible (exit 1). | ✅ |
| **MCP** | `CONNECTION_CLOSED` causado por la ruta **relativa** en el `.mcp.json` del workspace padre (`node .agents/mcp-server.mjs`), resuelta desde otro cwd → `MODULE_NOT_FOUND`. | ✅ |
| **Seguridad** | Zip-slip, zip-bomb, lectura/escritura arbitraria vía MCP, ReDoS que cuelga el servidor y **fuga de valores `.prop`** a OpenAPI/Postman (contradice la regla de privacidad del propio proyecto). | ✅ |
| **Formatos generados** | `.project` con una nature que no existe, `value_mapping.xml` en un formato que no aparece en ninguna exportación real, regla de Basic Auth que solo ve XI/AS2. | ✅ |
| **Runtime SAP** | El pack asume Groovy 2.4. SAP ofrece desde el 2025-12-07 el **Script step 2.0 = Groovy 4.0.x**, con *Upgrade Readiness Checks*. Camel Simple `${property.X}` está eliminado en Camel 3. | ✅ |
| **Fidelidad** | Validadores basados en regex: no comprueban XML bien formado, no respetan strings ni comentarios, ni comillas simples ni el namespace por defecto. El simulador `.mmap` (sin contextos ni colas) responde `success:true`. El builder genera un `.iflw` "100/100" sin `sequenceFlow` ni `BPMNShape`. | ✅ |
| **Docs** | Nombres de scripts obsoletos (`test-cpi-regex.mjs`, `validate-mock-suite.mjs`), códigos de regla documentados que no existen en el código, afirmaciones sin fuente. | ✅ |

**Resultado de la verificación:** 30 de 31 bugs reproducidos (R1 parcial). En la versión anterior de este informe había 13 afirmaciones exageradas o imprecisas; están corregidas abajo y resumidas en el §6.

---

## 1. P0 — Bloqueantes (corregir primero)

### 1.1 Arranque roto en rutas con espacios / no-ASCII — ✅
- 19 ocurrencias, 15 en `skills/`: `mcp-server.mjs:33,795`, `setup-skills.mjs:19`, `verify-all.mjs:9`, `validate-groovy.mjs:1030`, `audit-groovy.mjs:121`, `inspect-iflow-zip.mjs:989`, `build-cpi-package.mjs:410`, `test-camel-regex.mjs:100`…
- Efecto: el MCP server y los CLIs terminan en silencio con exit 0. `verify-all` **no** falla en silencio: sale con exit 1 y muestra los errores de los módulos hijos.
- **Fix**: `const __filename = fileURLToPath(import.meta.url); const isMain = realpathSync(process.argv[1]) === realpathSync(__filename);` (el `realpath` cubre también el bin de npm vía symlink). Extraer a `shared/cli-utils.mjs`.

### 1.2 MCP `CONNECTION_CLOSED` — ✅
- `setup-skills.mjs:110-113,206-214` escribe rutas relativas en la config MCP. Claude Code no documenta desde qué cwd resuelve una ruta relativa en `args`.
- **Fix verificado** (Claude Code expande `${VAR}` y `${VAR:-default}` en `.mcp.json`): `"args": ["${CLAUDE_PROJECT_DIR:-.}/.agents/mcp-server.mjs"]`, o una ruta absoluta. Si se distribuye como plugin, `${CLAUDE_PLUGIN_ROOT}`. Hay que regenerar `sapsuite/.mcp.json`. El destino `sapsuite/.agents/mcp-server.mjs` existe y es idéntico al del repo.
- Ojo: aunque se arregle la ruta, el bug del §1.1 hace que el servidor salga en silencio si la ruta absoluta tiene espacios. Hay que corregir los dos.

### 1.3 Seguridad — ✅ (todos reproducidos)
| ID | Ubicación | Problema | Fix |
|---|---|---|---|
| S1 | `inspect-iflow-zip.mjs:411-418`, `zip-utils.mjs:42` | Zip-slip (repro: escribe fuera de `--extract-dir`) | `path.resolve` + comprobar prefijo; rechazar rutas absolutas y `..` también en el writer |
| S2 | `zip-utils.mjs:169,176` | Zip-bomb (repros: 51 KB → 52 MB; 204 KB → 200 MB y 654 MB RSS) | `maxOutputLength`, límite de ratio y de tamaño total; no convertir binarios a string |
| S3 | `mcp-server.mjs:391-616` | Lectura/escritura arbitraria (`outPath`, `filePath`, `specPath`…) | Restringir a una raíz permitida (workspace) |
| S4 | `mcp-server.mjs:352-361`, `zip-utils.mjs:201`, `export-api-client.mjs:205,571`, `diff-iflow-zip.mjs:135` | **Fuga de valores `.prop`** (`showPropValues:true`, resolución `{{param}}`). Repro: un valor sintético llega a la salida OpenAPI y Postman | Redacción por defecto; flag explícito opt-in fuera del MCP |
| S5 | `test-camel-regex.mjs:36`, `zip-utils.mjs:258` | ReDoS (`^(a|aa)*$` cuelga el servidor > 8 s) | Ejecutar en `worker_threads` con timeout |

### 1.4 Corrupción de artefactos
- ✅/🟡 `clone-iflow-bundle.mjs:~93`: el reemplazo por subcadena en `MANIFEST.MF` no vuelve a plegar las líneas a 72 bytes (repro: líneas de 93–135 bytes) y corrompe identificadores que contienen el nombre. **Matiz:** la especificación JAR exige ≤ 72 bytes y las exportaciones de SAP pliegan a 72, pero no hay prueba de que CPI rechace líneas de 73–511 bytes (el lector del JDK solo falla por encima de 512). Hay que tratarlo como incumplimiento de la especificación con riesgo de rechazo, no como rechazo garantizado.
- ✅ `inspect-iflow-zip.mjs:935-952`: la remediación `timeouts` escribe en el `serviceTask` en vez del `messageFlow` del canal → **falso verde**. Verificado en una exportación real: la clave es `httpRequestTimeout` (no `requestTimeout`) y vive en `bpmn2:messageFlow/extensionElements`.
- ✅ `inspect-iflow-zip.mjs:897-901`: la remediación `manifest` elimina las líneas en blanco y funde las secciones `Name:`.
- ✅ `inspect-iflow-zip.mjs:959-964`: la remediación reescribe `groovy.xml.XmlSlurper` → `groovy.util.XmlSlurper`, que **no existe en Groovy 4** (confirmado: eliminado en Groovy 4).

### 1.5 Formatos que no coinciden con SAP (nuevo, verificado contra exportaciones reales) — ✅
- **`.project`** (`build-cpi-package.mjs:57`): usa `com.sap.ide.ifl.nature.iflow`, que no aparece en ninguna exportación. Lo real es el buildCommand `org.eclipse.jdt.core.javabuilder` y tres natures: `org.eclipse.jdt.core.javanature`, `com.sap.ide.ifl.project.support.project.nature` y `com.sap.ide.ifl.bsn`.
- **Value Mapping** (`build-value-mapping.mjs:104-150`):
  - XML real: `<vm version="2.0"><group id="<hex32>"><entry><agency/><schema/><value/></entry>…</group></vm>`, opcionalmente con `isDefault="true"`. El toolkit genera `ns2:valueMapping/valueEntry/val`, que no aparece en ninguna de las 4 fuentes independientes.
  - Al MANIFEST le faltan `Import-Package: com.sap.xi.mapping.camel.valmap` y `Bundle-Activator: com.sap.xi.mapping.camel.valmap.ValueMappingActivator`. `SAP-BundleType: ValueMapping` es correcto.
  - Nature real: `com.sap.ide.ifl.valmap` (+ `project.support.project.nature` + `javanature`), no `com.sap.ide.ifl.nature.valuemapping`.
- **Regla de Basic Auth** (`inspect-iflow-zip.mjs:128`): solo comprueba `authenticationType=BasicAuthentication`, que solo cubre XI y AS2. Claves reales por adaptador (según CPILint): HTTP/OData `authenticationMethod=Basic`; SOAP/IDoc `authentication=Basic`; XI `AuthenticationType=BasicAuthentication`; AS2 `authenticationType=BasicAuthentication`; AS4 `authenticationType=basic`. Exención para `proxyType=sapcc`.

### 1.6 Runtime SAP actual — ✅ (con correcciones)
- **Groovy dual**: el Script step **1.1** (Groovy 2.4) y el **2.0** (Groovy 4.0.x; 4.0.26 en el lanzamiento del 2025-12-07, release 2510) conviven, con botones Upgrade/Downgrade. Añadir `--step-version 1.1|2.0` (o `--groovy 2.4|4`) a `validate-groovy.mjs`. En 2.0:
  - `groovy.util.XmlSlurper/XmlParser/slurpersupport.GPathResult/XmlNodePrinter` → **CRITICAL** (no compilan en Groovy 4).
  - `import org.apache.camel.*` → **HIGH / advertencia**: SAP lo marca en Upgrade Readiness, pero el iFlow se despliega.
  - `Date.format/parse` → **advertencia** que recomienda `java.time`. En Groovy 4 se movieron a `groovy-dateutil`, pero no se sabe si CPI lo incluye.
  - API v2 `com.sap.it.script.v2.api.Message/Exchange` confirmada.
  - ❌ No hay que inferir la versión por la ruta `/script/v2/` del zip: no está documentado. Hay que leerla del atributo del paso en el `.iflw` (nombre exacto pendiente, §4) o pedirla por flag.
  - 🟡 "Java 17" solo se deduce de forma indirecta (KBA 3648304 sobre XmlUtil en Java 17); no está en la doc del Script step.
- Plantilla `--template xml-slurper --api v2`: genera `groovy.util.XmlSlurper` y saca 85/100 (`validate-groovy.mjs:605,644`). La XXE con `setFeature(...,false)` tampoco se detecta en esa plantilla.
- **Camel Simple en Camel 3.14.7** (en despliegue gradual):
  - `${property.X}` está **eliminado** → `${exchangeProperty.X}` (que existe desde Camel 2.15, así que es seguro en cualquier tenant). Para el pack es una **mejora de preset**, no un bug del motor.
  - 🟡 `${in.body}` está **deprecado pero sigue funcionando**. Lo que de verdad rompe es la variante con mayúsculas (`${In.Body}`). Recomendar `${body}`.
  - Archivos afectados: `test-camel-regex.mjs:132`, `regex-presets.md:26,37`, `SKILL.md:17` (KBA 3383568, 3765125).

---

## 2. P1 — Importantes

### 2.1 Groovy validator / auditor — ✅ (G1–G9 reproducidos)
- **Tokenizer mínimo** que elimine strings (`"`, `'`, `"""`, `${}`) y comentarios antes de aplicar reglas (`:36-77`). Hoy: `"static def x"` → CRITICAL (falso positivo); `"a//b"` borra el resto de la línea (falso negativo).
- Los imports con alias (`as X`) o tras `;` se saltan **todas** las reglas de import (`:148`).
- XXE: solo comprueba que aparezca la URL de la feature, así que `setFeature(..., false)` pasa (`:323-336`). Hay que cubrir StAX, `TransformerFactory`, `SchemaFactory` y `ACCESS_EXTERNAL_DTD`.
- `processData(Message msg)` con nombre ≠ `message` → CRITICAL (falso positivo); `return message` en un helper satisface la regla (falso negativo) (`:111,123`).
- `static` en métodos → falso positivo; `static int/StringBuilder/final Map` → falso negativo (`:270`).
- Los ámbitos de `try/catch/finally` e `if` alrededor de `addAttachmentAsString` se evalúan a nivel de archivo (`:358,390,436`); las excepciones tragadas no se detectan.
- `READER_GETTEXT_CHARSET_ERROR` decide por el nombre de la variable o por la presencia global de `InputStream` (`:238-243`).
- No detecta secretos en mapas, setters ni `Authorization: Basic …` (`:419`).
- Whitelist de cabeceras Camel escribibles (`CamelHttpResponseCode`, `CamelFileName`, `CamelCharsetName`) (`:497`). 🟡 Su uso está documentado por SAP en adaptadores concretos, pero no hay una lista oficial de cabeceras "escribibles".
- Plantilla `mpl-custom-headers`: `SAP_MessageProcessingLogCustomStatus` es una **property** (máx. 40 caracteres), no un header (`:705,731`). ✅
- `audit-groovy --json` siempre sale con exit 0 (`audit-groovy.mjs:180-186`); `--api v9` cae a v1 sin avisar; el escaneo de carpetas no es recursivo (`:1089`). G9 es peor de lo que se decía: sin `--refactored` sale con exit 0 aunque `passed:false`.

### 2.2 ZIP inspector / Architect — ✅ (Z1–Z8 reproducidos)
- `--remediate --out X` interpreta `--out` como lista de fixes y responde `[OK]` (`:1007`).
- Parseo de MANIFEST: `Import-Package` se parte por las `,` que hay dentro de comillas (`:42-45`), `trim()` total en las continuaciones (`:24`), detección case-sensitive de `META-INF/MANIFEST.MF` (`:432`).
- Solo se audita `iflwFiles[0]` (`:528`); el Exception Subprocess se detecta a nivel de documento, no por proceso (`:93`).
- Builder (`build-cpi-package.mjs:357-406`): el `.iflw` sale sin `sequenceFlow`, `cmdVariantUri`, `componentVersion` ni `BPMNShape/BPMNEdge`; `{{INBOUND_PATH}}` queda sin definir y aun así puntúa 100/100. Hay que añadir validación BPMN2 (bien formado + conectividad + diagrama + placeholders).
  - 🟡 Las propiedades existen en todas las exportaciones reales (p. ej. `cmdVariantUri=ctype::AdapterVariant/cname::sap:HTTP/tp::HTTP/mp::None/direction::Receiver/version::1.7.2`, `ctype::FlowstepVariant/cname::NonLoopingProcess/version::1.0.2`). ❔ Si son *obligatorias* y si SAP importa un `.iflw` sin `bpmndi` no está documentado: se recomienda generarlas siempre.
- 🟡 `.prop`/`metainfo.prop` sin escapar ni codificar en ISO-8859-1 (`:122-124,218`). `java.util.Properties.store()` escribe ISO-8859-1 con `\uXXXX`, pero no hay documentación SAP que diga que CPI usa ese método. Lo prudente es escapar a `\uXXXX` todo lo no-ASCII (válido en cualquier lectura).
- Tope de recursión de zips anidados (se procesan 300 niveles) (`:591`); CRC, ZIP64 y CP437 no soportados (`zip-utils.mjs:131-172`).
- 🟡 "Un artefacto por zip": es cierto para la subida de un iFlow o un Value Mapping, pero **falso** para *Design > Import* de un zip de paquete (admite varios artefactos). El inspector debe distinguir los dos casos.

### 2.3 Studios — ✅ (R2, X1, X2, M1, M2, K1 reproducidos; R1 parcial)
- **Regex**: usa `RegExp` de JS en lugar de la semántica Java. `\p{L}` falla en silencio y `(?i)` se rechaza, y ambos son válidos en Java (✅). También se rechazan `a++`, `(?>…)` y `\A…\z`. Camel `regex` usa `matches()` (coincidencia completa). Una `'` en el patrón rompe la expresión Simple (`:58`); `replaceAll(...,'$1')` sin grupos → "No group 1" (`:54`). La "tabla Regular Expression del Content Modifier" no aparece en la doc: hay que eliminarla.
- **Operadores Simple**: 🟡 `not in`, `not contains`, `not regex` **son aceptados** por el parser de Camel 3 (no "no soportados", como decía el informe anterior). Se recomiendan las formas `!in`, `!contains`, `!regex`.
- **XSLT**: falsos positivos en Text Value Templates XSLT 3.0 (`expand-text`) y en `{}` dentro de `xsl:text` (`validate-xslt.mjs:49-56`); comillas simples (`:28,36,76`); `#all cpi` aceptado y usado en el demo (`:121`); un XSLT mal formado devuelve `valid:true`. XSLT 3.0 está soportado desde 2019 (✅); streaming confirmado. 🟡 La SKILL contradice HE frente a streaming (`SKILL.md:42`): la edición de Saxon no está documentada oficialmente, así que hay que quitar la afirmación.
- **XSD**: el namespace por defecto y las comillas simples dan errores falsos (`validate-xsd.mjs:137,143`); `xs:import/include` y los tipos indefinidos no se validan; la inferencia genera nombres XML inválidos, `10.0` → integer y `2025-13-45` → date.
- **build-mmap**: `split(':')` rompe las rutas Windows `C:\…` (`build-mmap.mjs:243`).
- **simulate-mmap**: no tiene contextos, colas ni funciones estándar; solo toma la primera ocurrencia en repeticiones; doble escape (`&amp;amp;`); `<ns0:…>` sin `xmlns`; y responde `success:true` con funciones no soportadas (`:52,102-117,162-182,224`). Debe devolver `unsupported[]` y `success:false`.
- **Mock data**: en XML solo valida la etiqueta raíz (`pack-mock-suite.mjs:117-128`); los desajustes de correlación son warnings con exit 0, lo que contradice el "Verification Gate" (`:252`); claves por subcadena (`:161`); TypeError sin `name` (`:197`); ENOENT por falta de `mkdir` (`:410`); escribe el ZIP aunque sea inválido.

### 2.4 MCP server — ✅ (probado por stdio)
- Negociar `protocolVersion` contra una lista soportada: hoy acepta y devuelve `"1999-01-01"` (`:699`).
- Usar errores JSON-RPC: -32602 para herramienta, recurso o prompt desconocido (hoy devuelve `isError`), y -32700 para JSON malformado (hoy no responde) (`:782-790,858`). 🟡 En el -32700 hay que **omitir `id`** en lugar de mandar `id:null`, que choca con el schema TypeScript de MCP.
- Validar los argumentos contra `inputSchema`: hoy `cpi_inspect_zip` sin `filePath` ejecuta la demo.
- Ninguna herramienta tiene `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), `title` ni `outputSchema` + `structuredContent`. Añadirlos, junto con `additionalProperties:false`.
- El handler es síncrono: una herramienta lenta bloquea `ping`, y no hay cancelación.

### 2.5 Instalador (`setup-skills.mjs`) — ✅
- Sobrescribe sin avisar `AGENTS.md`, `copilot-instructions.md`, Windsurf y Cline (`:133`).
- `mergeMcpJsonFile` reemplaza por `{}` cualquier JSON que no pueda parsear (p. ej. el JSONC de VS Code) → **borra los otros servidores** (repro confirmado) (`:39-41`).
- Faltan `--dry-run`, `--uninstall`, backups y modo symlink; un `--agent` desconocido no da error; deja ficheros obsoletos.

---

## 3. P2 — Mejoras y evolución

### 3.1 Nuevas reglas (Upgrade Readiness y guías de diseño SAP)
- **UR-001..00x** (✅ las 6 guidelines de Upgrade Readiness, publicadas el 2025-09-07): clases internas de SAP/Camel, librerías no documentadas, imports no usados, recursos referenciados sin ruta relativa a la raíz. 🟡 Del contenido de la KBA 3645155 solo se pudo ver la vista previa.
- ✅ `XmlUtil.serialize` añade saltos de línea en Java 17 (KBA 3648304). Clases eliminadas en Java 17 (`sun.misc.BASE64Encoder`, `javax.xml.bind.DatatypeConverter`, Nashorn): es un hecho del JDK, aplicable si el runtime es Java 17.
- Antipatrones Groovy: materializar el body entero (`getBody(byte[])`, `as String`), lecturas repetidas, payload en un header, datos sensibles en logs o MPL, properties no serializables (Reader, `GPathResult`), `GStringImpl` en headers, SQL vía GString, `Thread.sleep`/`System.exit`/`Runtime.exec`/`new File`, `ITApiFactory` en bucles, `ValueMappingApi` sin fallback null.
- iFlow (estilo CPILint + guías SAP). Nombres reales de las reglas de CPILint para alinear IDs:
  - `cleartext-basic-auth-not-allowed`
  - `unencrypted-data-store-write-not-allowed`
  - `matching-process-direct-channels-required`
  - `iflow-description-required`
  - `csrf-protection-required`
  - `client-cert-sender-channel-auth-not-allowed`
  - `duplicate-resources-not-allowed`
  - `multi-condition-type-routers-not-allowed`
  - `unencrypted-endpoints-not-allowed`
  - `iflow-name` y `naming-conventions`
  - Allowed/disallowed: adapters, mapping types, scripting languages, XSLT versions, java archives, user roles.
  - Además: hardcode de host SFTP, proxy o colas JMS; `{{param}}` sin definir o sin usar; nivel de log MPL; retry/dead-letter JMS; timeouts por tipo de adaptador; `Allowed Headers: *`; recursos no referenciados; colisión de colas JMS.
  - 🟡 CPILint: última versión v1.1.0 y último commit el 2025-05-13. Lleva unos 18 meses inactivo, pero no está archivado ni declarado abandonado.
- 🟡 SuccessFactors: `X-SF-Correlation-Id` está obsoleto en favor de `X-Correlation-Id` (ago-2026), **solo en los receptores SF OData V2/V4 y REST**. El adaptador SF SOAP sigue enviando `X-SF-Correlation-Id`.
- ✅ W3C `traceparent`: CPI lo guarda en el MPL (sep-2026) y el adaptador HTTP ≥ 1.22 lo envía por defecto. Se desactiva con `SAP_DisableExternalW3CTraceContextTransmission`. Llevarlo a plantillas y mocks.

### 3.2 Nuevas capacidades
- **Perfil de runtime Cloud vs Edge Integration Cell** (✅): adaptadores **solo para EIC**: OFTP (emisor y receptor), NFS (emisor y receptor) y RFC Sender. **No soportados en EIC**: Idempotent Repository en MPL, Principal Propagation y WebSocket RFC. La lista completa está en la SAP Note 3391207 (no consultable). Detectar patrones Neo: ✅ fin el 2028-12-31 (la KBA 3365019 trata de Cloud Portal en Neo, pero dice textualmente que Neo termina en esa fecha).
- **Where-used offline del Security Material**: listar los alias de credenciales referenciados en `.iflw` y scripts (solo nombres), incluidas las referencias dinámicas que la herramienta de SAP no detecta.
- **Plantilla/validador "Java Mapping → Groovy"** para migraciones PI/PO (✅ PO 7.5: mantenimiento principal hasta finales de 2027 y extendido opcional hasta 2030).
- **Exportador OpenAPI apto para el artefacto "MCP Server" de Integration Suite** (✅ el tutorial usa "HTTP Endpoint with OpenAPI Specification"; requiere los planes Enhanced, Premium o Trial con Integration Cell activado). ❌ **Corrección:** debe generar **OpenAPI 3.0.0–3.0.3**, no 3.1. SAP APIM y la creación de MCP solo documentan 2.0/3.0, así que no hay que ofrecer la opción 3.1.
- **Simulador `.mmap`**: contextos y colas, funciones estándar (`removeContexts`, `splitByValue`, `useOneAsMany`, `createIf`, `mapWithDefault`, `formatByExample`…), generación de XML de prueba desde la estructura origen.
- **Mock data**: CSV, IDoc plano, EDI (X12/EDIFACT), headers/properties por muestra; export al formato de iFlow Simulation / Integration Suite Testing.
- Catálogo versionado de adaptadores y `componentVersion`/`cmdVariantUri` en lugar de valores fijos.
- Posicionar el MCP local como **validación determinista previa al despliegue**, complementaria a los MCP comunitarios que operan sobre la OData API de CPI.

### 3.3 Distribución y formato
- **Plugin de Claude Code** (`.claude-plugin/plugin.json` + `.mcp.json` con `${CLAUDE_PLUGIN_ROOT}` + `marketplace.json`): elimina las copias duplicadas y el problema de rutas. El instalador quedaría solo para el resto de IDEs.
- 🟡 Windsurf: `trigger:` en el frontmatter es recomendable pero **no consta como obligatorio** (la doc está ahora en docs.devin.ai). Copilot: contexto duplicado (`copilot-instructions.md` + `*.instructions.md applyTo **`). Cursor: `alwaysApply:true` inyecta todo AGENTS.md en cada mensaje.
- ✅ `sap-cpi-xsd-studio` contiene `<xiObj>` en `description`: los límites de la spec de skills impiden etiquetas XML en ese campo.
- ✅ Compatibilidad con la MCP spec 2026-07-28 (stateless: `server/discover`, `resultType`, error -32022) manteniendo la 2025-11-25.
- ✅ `engines: >=22` (Node 18 y 20 están fuera de soporte).

### 3.4 Tests y CI
- Tests negativos **por `ruleId`** (positivo/negativo) para cada validador; matriz plantilla × `{v1,v2}` (habría detectado el bug de xml-slurper v2).
- Fixtures adversariales: zip-slip, bomb, ZIP64, CRC, CP437, manifest en minúsculas, zips anidados profundos.
- Fixtures de formato tomadas de exportaciones públicas reales (estructura, sin datos): `.project`, `value_mapping.xml`, `messageFlow` con `httpRequestTimeout`, canales con cada clave de autenticación.
- Round-trip clone → inspect exigiendo líneas MANIFEST ≤ 72 bytes; remediate → inspect verificando el cambio real.
- Test E2E del MCP **por stdio** (el self-test actual llama al handler en proceso y no detectó los fallos de arranque).
- Test de que ningún valor `.prop` aparece en la salida de export-api-client, diff y MCP.
- Ejecución desde una ruta con espacios.
- GitHub Actions: ubuntu + windows × Node 22/24; `node --test`.

### 3.5 Documentación
- Nombres obsoletos: `test-cpi-regex.mjs` → `test-camel-regex.mjs` y `validate-mock-suite.mjs` → `pack-mock-suite.mjs` en `rules/sap-cpi-continuous-learning.md:32-33`, `.claude/rules/…`, `sap-cpi-regex-studio/SKILL.md:52` y `sap-cpi-mock-data-generator/SKILL.md:60`.
- `VALIDATION_RULES.md`: códigos inexistentes (`UPGRADE-WILDCARD`, `SEC-XXE`, `TZ-DEFAULT`…), numeración repetida, el flag `--directives` no existe, reglas implementadas sin documentar, severidades distintas a las del código (IFLW-001, IFLW-003); §3.4/§3.5 contradicen el código XSLT.
- `groovy-generator/SKILL.md:11` ("Groovy 2.4/3.0+": CPI nunca ofreció 3.x; lo correcto es Script step 1.1 = 2.4, 2.0 = 4.0.x) y `LESSONS_LEARNED.md:31`, desactualizados.
- Afirmaciones sin fuente que hay que eliminar o marcar como no oficiales: Xalan para XSLT 1.0 (❔), Saxon HE/EE (❔), prohibición de `xsd:all`, límite de 20.000 nodos, SAP Note 2624922, "not in no soportado" (❌ es falso, el parser lo acepta).
- ✅ README:49: `.mcp.json` no es la config de Claude Desktop (es `claude_desktop_config.json`).
- La regla de aprendizaje continuo está triplicada (AGENTS.md, CLAUDE.md, `rules/`) e incrustada en cada fichero generado: debería tener una fuente única.

---

## 4. Pendiente de verificar en tenant / export real (❔)
- ✅ **Resuelto:** ubicación de `value_mapping.xml` → **raíz del bundle**, según el ejemplo oficial `TestValueMap.zip` de SAP (SAP Business Accelerator Hub, guía "Accessing valueMaps from a script"). Su MANIFEST lleva `Bundle-SymbolicName: <Nombre>; singleton:=true` y su `.project` (antiguo) usa la nature `com.sap.ide.ifl.bsn`. Ver `LL-018`.
- Nombre exacto del atributo de versión del Script step en `.iflw` (sin Javadoc ni doc pública).
- Versiones exactas de Groovy/Java del runtime (validar con `GroovySystem.getVersion()` y `System.getProperty('java.version')`), si CPI incluye `groovy-dateutil`, y planes para Camel 4 o Java 21.
- Si CPI rechaza líneas de MANIFEST de 73–511 bytes (KBA 3448807 sin causa visible).
- Si `cmdVariantUri`/`componentVersion`/`bpmndi` son obligatorios en la importación.
- Codificación con la que CPI lee y escribe `parameters.prop`/`metainfo.prop`.
- Edición y versión de Saxon; motor de XSLT 1.0.
- Contenido completo de la KBA 3435465 (404) y de la SAP Note 3391207 (lista EIC).
- Modelado de `getHeader/getProperty` en `.mmap`; GA de Joule en Integration Suite y del PI/PO migration agent; límites de JMS y Data Store.

---

## 5. Fuentes principales
- **SAP Help (markdown oficial):** [SAP-docs/btp-integration-suite](https://github.com/SAP-docs/btp-integration-suite) — Script step, Camel Simple, connectivity options (EIC), adaptadores OFTP/HTTP receiver, creación de iFlows, importación de paquetes, creación de MCP server desde API, OpenAPI 3.0 en APIM.
- **SAP Integration Suite monthly updates:** [feb-26](https://assets.dm.ux.sap.com/sap-user-groups/pdfs/260224_sap_integration_suite_monthly_update.pdf) · [mar-26](https://assets.dm.ux.sap.com/sap-user-groups/pdfs/260331_sap_integration_suite_monthly_update.pdf) · [may-26](https://assets.dm.ux.sap.com/sap-user-groups/pdfs/260526_sap_integration_suite_monthly_update.pdf) · [ago-26](https://assets.dm.ux.sap.com/sap-user-groups/pdfs/260825_sap_integration_suite_monthly_update.pdf) · [sep-26](https://assets.dm.ux.sap.com/sap-user-groups/pdfs/260929_sap_integration_suite_monthly_update.pdf)
- **KBAs:**
  - [3645155](https://userapps.support.sap.com/sap/support/knowledge/en/3645155) (Upgrade Readiness)
  - [3768635](https://userapps.support.sap.com/sap/support/knowledge/en/3768635) (Groovy 2.0)
  - [3648304](https://userapps.support.sap.com/sap/support/knowledge/en/3648304) (XmlUtil Java 17)
  - [3383568](https://userapps.support.sap.com/sap/support/knowledge/en/3383568) / [3765125](https://userapps.support.sap.com/sap/support/knowledge/en/3765125) / [3383659](https://userapps.support.sap.com/sap/support/knowledge/en/3383659) (Simple Camel 3)
  - [3448807](https://userapps.support.sap.com/sap/support/knowledge/en/3448807) (manifest)
  - [3365019](https://userapps.support.sap.com/sap/support/knowledge/en/3365019) (Neo EOL)
- **Formatos reales:**
  - [codebude/cpi-dashboard](https://github.com/codebude/cpi-dashboard/tree/master/IFlow/Source) (iFlow completo, `.project`)
  - [nesun3/sap-cloud-integration-artifacts](https://github.com/nesun3/sap-cloud-integration-artifacts/tree/main/ValueMappings/UnZip) (Value Mappings)
  - [CPILint rules/xquery](https://github.com/mwittrock/cpilint)
- **Estándares:** [JAR spec](https://docs.oracle.com/en/java/javase/21/docs/specs/jar/jar.html) · [JDK Manifest.java](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/jar/Manifest.java) · [JDK Properties.java](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/Properties.java)
- **Otros SAP:** [Upgrade Readiness Design Guidelines (SAP blog)](https://community.sap.com/t5/technology-blog-posts-by-sap/sap-cloud-integration-upgrade-readiness-design-guidelines-best-practices/ba-p/14285427) · [Integration Suite MCP Server tutorial](https://developers.sap.com/tutorials/integration-suite-mcp-server.html) · [Estrategia de mantenimiento NW 7.5](https://blogs.sap.com/t5/technology-blogs-by-sap/maintenance-strategy-for-sap-netweaver-7-5-fully-aligned-with-sap-business/ba-p/13456253)
- **MCP / IDEs:** [MCP versioning](https://modelcontextprotocol.io/specification/versioning) · [Agent Skills spec](https://agentskills.io/specification) · [Claude Code plugins](https://code.claude.com/docs/en/plugins) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Codex skills](https://developers.openai.com/codex/skills) · [VS Code agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)

---

## 6. Registro de correcciones respecto a la versión anterior
| Afirmación anterior | Estado verificado |
|---|---|
| "≈30 ocurrencias" del bug `isMain` | ❌ Son **19** (15 en `skills/`) |
| verify-all sale con exit 0 en silencio | ❌ Sale con **exit 1** y muestra errores (el MCP y los CLIs sí salen mudos) |
| `import org.apache.camel.*` en Groovy 2.0 = CRITICAL | ❌ Es una **advertencia** de Upgrade Readiness → HIGH |
| Inferir la versión del Script step por la ruta `/script/v2/` | ❌ No documentado; eliminado |
| `Date.format/parse` = CRITICAL en 2.0 | 🟡 Advertencia → recomendar `java.time` |
| Script step "1.x", Groovy 2.0 sobre Java 17 | 🟡 Es la **1.1**; Java 17 solo se deduce de forma indirecta |
| `${in.body}` falla en Camel 3.14 | 🟡 Deprecado pero funciona; falla `${In.Body}` |
| `${property.X}` es un bug del preset | 🟡 `property` sí está eliminado; corregir el preset es una mejora |
| "not in" no soportado | ❌ El parser lo acepta; se prefiere `!in` |
| MANIFEST de 88 bytes → SAP rechaza el import | 🟡 Líneas de 93–135 bytes; incumple la spec JAR, pero el rechazo no está probado |
| Opción de export OpenAPI 3.1 | ❌ SAP APIM y MCP Server solo admiten 3.0.x (3.0.0–3.0.3) |
| -32700 con `id:null` | 🟡 Hay que omitir `id` |
| Windsurf requiere `trigger:` | 🟡 No consta como obligatorio |
| `X-SF-Correlation-Id` obsoleto en general | 🟡 Solo en SF OData y REST, no en SOAP |
| Basic Auth / value mapping / nature "probablemente" incorrectos | ✅ Confirmados como incorrectos contra exportaciones reales (§1.5) |
| Timeout en `messageFlow` "probable" | ✅ Confirmado; la clave es `httpRequestTimeout` |
