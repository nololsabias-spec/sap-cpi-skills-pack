# Prompt — Plan de la base de pruebas integral

> Prompt listo para entregar a un agente (sesión nueva) para construir la base de pruebas del pack. Cubre las 8 skills, todos los scripts CLI, el servidor MCP, flujos E2E y un catálogo de prompts de usuario. Relacionado: [`GAP_ANALYSIS_2026-11.md` §3.4](./GAP_ANALYSIS_2026-11.md).
>
> Recomendación: ejecutarlo por fases y revisar la **Fase 0** (inventario y matriz de cobertura) antes de escribir tests.

---

## Misión

Eres un ingeniero de QA senior especializado en SAP Integration Suite (Cloud Integration / CPI) y en tooling Node.js sin dependencias. Tu objetivo es diseñar e implementar una **base de pruebas determinista y reproducible**. Debe cubrir las 8 skills, todos sus scripts CLI, el servidor MCP (todas sus tools y resources) y los **flujos de usuario reales de extremo a extremo**, incluidas las peticiones (prompts) que haría un usuario en lenguaje natural.

Trabaja en el repo `sap-cpi-skills-pack`. Antes de escribir nada, lee:
- `AGENTS.md`, `CLAUDE.md` y `rules/sap-cpi-continuous-learning.md`
- `docs/VALIDATION_RULES.md`, `docs/LESSONS_LEARNED.md`, `docs/CLI_REFERENCE.md` y `docs/GAP_ANALYSIS_2026-11.md`
- cada `skills/*/SKILL.md` y sus `references/`
- `verify-all.mjs`, `mcp-server.mjs` y `shared/*.mjs`

---

## 0. Restricciones innegociables

1. **Cero dependencias.** Usa solo Node con `node:test`, `node:assert/strict`, `node:child_process`, `node:fs` y `node:zlib`. Nada de `npm install`.
2. **Privacidad estricta (Zero Data Leakage).**
   - Todos los fixtures son **sintéticos**: nombres genéricos (`Demo_Order_Replication`, `ACME_Test`) y endpoints `https://example.com/...` o `{{param}}`.
   - Nunca uses nombres de clientes, proyectos privados, URLs reales, credenciales ni payloads confidenciales.
   - Los `parameters.prop` de los fixtures llevan valores dummy obvios (`dummy-host.example.com`).
   - Los tests deben **verificar** que esos valores salen como `[REDACTED]` salvo con `--resolve-params` / `showPropValues`.
3. **Determinismo.**
   - Nada de red, reloj ni aleatoriedad sin semilla.
   - Los IDs (hex32 de Value Mapping, UUIDs) se inyectan o se normalizan antes de comparar.
   - Las fechas se fijan o se enmascaran.
4. **Multiplataforma.**
   - Windows (Git Bash / PowerShell), macOS y Linux.
   - Rutas con `path.join` y comparaciones con rutas normalizadas.
   - Prueba también rutas con espacios y con caracteres no ASCII (`ñ`, `á`).
5. **Aislamiento.**
   - Cada test trabaja en `fs.mkdtempSync(os.tmpdir())` y limpia al terminar.
   - Ningún test escribe dentro de `skills/` ni modifica el repo.
6. **No rompas lo existente.** `node verify-all.mjs` debe seguir pasando y además lanzar la nueva suite.

---

## 1. Estructura a crear

```
tests/
  README.md                      # cómo ejecutar, añadir casos y regenerar golden files
  run-all.mjs                    # runner: node --test, filtros por capa/skill, resumen final
  helpers/
    cli.mjs                      # runCli(script, args, {cwd, env, stdin}) → {code, stdout, stderr, json}
    mcp.mjs                      # cliente JSON-RPC 2.0 stdio: initialize, tools/list, tools/call, resources/*
    zip.mjs                      # construir/leer .zip en memoria para fixtures y aserciones
    golden.mjs                   # compara con golden files; UPDATE_GOLDEN=1 los regenera
    normalize.mjs                # enmascara UUIDs, hex32, timestamps, rutas absolutas y CRLF
    fixtures-factory.mjs         # genera iFlows/bundles sintéticos parametrizables
  fixtures/
    iflows/      good/ bad/ edge/      # .iflw y bundles .zip
    groovy/      v1/ v2/ groovy24/ groovy4/ broken/
    xsd/ xslt/ mmap/ regex/ valuemap/ mock/
    security/                          # zip-slip, zip-bomb, .prop con secretos dummy, rutas fuera de raíz
  golden/                              # salidas esperadas normalizadas (.json / .xml / .MF)
  unit/          <skill>/<script>.test.mjs
  contract/      cli-contract.test.mjs        # flags, --json, exit codes, --help, errores de uso
  mcp/           mcp-protocol.test.mjs, mcp-tools.test.mjs, mcp-security.test.mjs
  e2e/           F01-*.test.mjs … F12-*.test.mjs
  regression/    LL-001.test.mjs … LL-0NN.test.mjs   # una por lección aprendida
  prompts/
    catalog.json                       # catálogo de prompts de usuario → enrutado esperado
    prompt-routing.test.mjs            # valida el catálogo contra SKILL.md y tools MCP
    EVAL_GUIDE.md                      # cómo evaluar manualmente/semiauto con un LLM
```

---

## 2. Capas de prueba

### Capa A — Unitarias (por script)
Para **cada** script de `skills/*/scripts/*.mjs` y `shared/*.mjs`:
- Funciones exportadas: caso feliz, bordes (vacío, enorme, unicode, BOM, CRLF) y entrada inválida.
- Cada **código de regla** de `docs/VALIDATION_RULES.md` necesita al menos un fixture que la dispare (positivo) y otro casi idéntico que no la dispare (negativo). Añade un test de meta-cobertura que lea `VALIDATION_RULES.md`, extraiga todos los códigos (`IFLW-*`, `ZIP-*`, `PRIV-*`, `GROOVY*_*`…) y falle si alguno no tiene su par de fixtures.

| Skill | Qué cubrir como mínimo |
|---|---|
| **sap-cpi-architect** | `build-cpi-package` (`.project` con javabuilder + 3 natures, MANIFEST plegado a 72 bytes con CRLF, `.iflw` BPMN2 válido); `build-value-mapping` (JSON y CSV, `<vm version="2.0">`, `group id` hex32, `isDefault`, `value_mapping.xml` en la raíz, `singleton:=true`, Activator/Import-Package; CSV con comillas, `;` vs `,`, agencia/identificador duplicados); `clone-iflow-bundle` (renombra solo identificadores completos, conserva secciones `Name:` del MANIFEST); `export-api-client` (Postman v2.1 + OpenAPI 3.0.3, CSRF, `{{param}}` por defecto, `--resolve-params`); `extract-for-docs` (8 secciones, PDF generado y no vacío) |
| **sap-cpi-groovy-generator** | Todas las plantillas × `--api v1/v2` × `--groovy 2.4/4` con score 100; reglas `GROOVY24_INVALID_XMLSLURPER_IMPORT`, `GROOVY4_REMOVED_GROOVY_UTIL_XML`, `GROOVY_VERSION_DEPENDENT_XML_API`, `GROOVY4_CAMEL_IMPORT`, `GROOVY4_DATE_EXTENSIONS` (incluido el falso positivo `String.format`); `--strict`; carpeta y `.zip` como entrada; `--groovy` inválido devuelve error de uso |
| **sap-cpi-code-auditor** | `audit-groovy` sobre scripts buenos, malos y mixtos; paso de `groovyVersion`; estabilidad del score |
| **sap-cpi-zip-inspector** | `inspect-iflow-zip` (5 puntos de control, Basic Auth por adaptador: HTTP/OData `authenticationMethod`, SOAP/IDoc `authentication`, XI `AuthenticationType`, AS2/AS4 `authenticationType`, exención `proxyType=sapcc`; timeouts solo en el messageFlow HTTP; remediación idempotente: aplicarla dos veces da el mismo resultado; nunca reescribe imports XmlSlurper); `diff-iflow-zip` (sin cambios, cambios de propiedades, pasos añadidos/eliminados, MANIFEST reordenado) |
| **sap-cpi-xsd-studio** | `validate-xsd` (XSD válido/inválido, imports, namespaces); `build-mmap`; `simulate-mmap` (funciones estándar, contextos, colas, valores nulos) |
| **sap-cpi-xslt-studio** | `validate-xslt` 1.0 y 2.0, funciones solo de 2.0 en una hoja 1.0, namespaces, `xsl:param` desde cabeceras |
| **sap-cpi-regex-studio** | `test-camel-regex`: presets; Camel 3 `${exchangeProperty.X}` correcto y `${property.X}` marcado; `${in.body}` como deprecado; `${In.Body}` como error; regex catastrófica (ReDoS) cortada por timeout en sandbox |
| **sap-cpi-mock-data-generator** | `pack-mock-suite`: semilla fija da una salida idéntica; tamaños; formatos XML/JSON/CSV/IDoc; coherencia con el XSD |

### Capa B — Contrato CLI
Para cada script: `--help`, argumento obligatorio ausente (exit ≠ 0 y mensaje en stderr), flag desconocido, `--json` con JSON válido parseable en stdout y sin ruido, exit codes (0 OK; ≠ 0 en CRITICAL cuando aplique `--strict`), funcionamiento si se ejecuta desde otro cwd (`isMainModule`) y si se importa como módulo sin efectos secundarios.

### Capa C — Servidor MCP
- **Protocolo**: `initialize` desde cwd = home, = repo y = subcarpeta; `tools/list` (el número de tools debe coincidir con `--self-test`); `resources/list` y `resources/read`; método desconocido devuelve error -32601; JSON malformado devuelve -32700; params inválidos devuelven -32602.
- **Tools**: genera los casos a partir de `tools/list` **dinámicamente**. Para cada tool hay que probar su `inputSchema`, una llamada válida mínima, una llamada con campos requeridos ausentes y la equivalencia con el CLI (mismo input da el mismo resultado normalizado).
- **Seguridad**:
  - Raíces permitidas: `CPI_MCP_ROOT`, `CLAUDE_PROJECT_DIR`, cwd, el directorio de instalación (`<ws>/.agents` → `<ws>`), tmpdir y `CPI_MCP_ALLOWED_ROOTS`.
  - Fuera de raíz: `C:/Windows/win.ini`, `/etc/passwd`, `..\..\` y symlinks que salen de la raíz deben bloquearse.
  - `CPI_MCP_UNSAFE_PATHS=1` desbloquea.
  - Los `.prop` salen redactados.
- **Instalación**: `setup-skills.mjs --target <tmp-ws> --mcp` debe escribir una ruta **absoluta** existente en `.mcp.json`, usar `${workspaceFolder}` en `.vscode/mcp.json` y dejar `.cursor/mcp.json` válido. Arranca el servidor instalado con cwd en una subcarpeta y con un `CLAUDE_PROJECT_DIR` distinto (regresión de CONNECTION_CLOSED, `LL-016`).

### Capa D — Flujos E2E (encadenan skills como lo haría un usuario)

| ID | Flujo | Pasos y aserciones |
|---|---|---|
| F01 | iFlow desde cero | spec → `build-cpi-package` → `inspect` (0 CRITICAL) → `.zip` importable (estructura OSGi correcta) |
| F02 | Auditar y remediar un bundle legado | bundle "malo" → `inspect` (lista esperada de hallazgos) → remediación → re-`inspect` (hallazgos resueltos) → `diff` (solo los cambios esperados) |
| F03 | Groovy end-to-end | plantilla v1/2.4 → validar → migrar a v2/4 → validar con `--groovy 4` → auditar → empaquetar en el iFlow → `inspect` |
| F04 | Mapping con XSD | XML de muestra → inferir XSD → `validate-xsd` → `build-mmap` → `simulate-mmap` con mocks → salida conforme al XSD destino |
| F05 | XSLT | XSLT 1.0 + payload mock → validar → salida esperada (golden) |
| F06 | Enrutado con regex/Camel Simple | condición de router → `test-camel-regex` → se incrusta en `.iflw` → `inspect` |
| F07 | Value Mapping | CSV → `build-value-mapping` → `.zip` → inspección estructural (raíz, MANIFEST, `.project`) → script Groovy que usa `ValueMappingApi` validado |
| F08 | Clonar para otro entorno o país | `clone-iflow-bundle` → `diff` contra el original (solo IDs y nombres) → `inspect` |
| F09 | Documentación y API | bundle → `extract-for-docs --pdf` (8 secciones) + `export-api-client` (Postman/OpenAPI; `{{param}}` sin resolver por defecto) |
| F10 | Suite mock E2E | XSD → `pack-mock-suite` (semilla) → cada mock valida contra el XSD → se usa en F04/F05 |
| F11 | Error real pegado por el usuario | texto de error CPI (`MissingMethodException`, `unable to resolve class groovy.xml.XmlSlurper`, MANIFEST inválido, `ValueMappingActivator.start()`) → la herramienta correcta lo detecta en el artefacto → la corrección propuesta pasa la validación |
| F12 | Mismo flujo por MCP | repite F01, F03 y F07 solo con `tools/call` y compara con la versión CLI |

### Capa E — Regresión de lecciones aprendidas
Una prueba por cada `LL-XXX` de `docs/LESSONS_LEARNED.md` que reproduzca el síntoma con un fixture mínimo y demuestre que la regla lo detecta o lo previene. Añade un meta-test que falle si existe una `LL-` sin su test.

### Capa F — Catálogo de prompts de usuario (enrutado de skills)
Crea `tests/prompts/catalog.json` con **al menos 120 prompts realistas**: mitad en español y mitad en inglés, más algunos con spanglish y erratas ("valida mi groovi", "el iflow no despliega"). Cada entrada:

```json
{
  "id": "P-042",
  "lang": "es",
  "prompt": "Tengo este script con import groovy.xml.XmlSlurper y CPI me dice unable to resolve class",
  "category": "error-runtime",
  "expectedSkills": ["sap-cpi-groovy-generator"],
  "expectedTools": ["cpi_validate_groovy"],
  "mustAskFirst": ["¿Script step 1.1 (Groovy 2.4) o 2.0 (Groovy 4)?"],
  "expectedRules": ["GROOVY24_INVALID_XMLSLURPER_IMPORT"],
  "mustNot": ["reescribir a groovy.util sin conocer la versión", "leer parameters.prop"],
  "fixture": "groovy/groovy24/xmlslurper-wrong-import.groovy",
  "triggersSelfEvolution": true
}
```

Categorías obligatorias, con un mínimo de 8 prompts por categoría:
1. **Crear** (iFlow, Groovy, XSD, XSLT, mmap, Value Mapping, regex, mocks)
2. **Validar / auditar** (archivo suelto, carpeta, `.zip`)
3. **Error de despliegue** (MANIFEST, `.project`, bundle corrupto, Value Mapping duplicado)
4. **Error de runtime** (Groovy, XSLT, adaptador, Camel Simple)
5. **Migración** (Groovy 2.4→4, API v1→v2, `${property}`→`${exchangeProperty}`, PI/PO→CPI)
6. **Documentar / exportar** (PDF, Postman, OpenAPI)
7. **Comparar / clonar** (diff, clonado de entornos)
8. **Seguridad** (Basic Auth, credenciales en claro, secretos en `.prop`)
9. **Ambiguos**: falta información y la skill debe preguntar (versión de Groovy, adaptador, sentido sync/async)
10. **Fuera de alcance o trampa**: debe negarse o redirigir. Incluye: "dame las contraseñas del parameters.prop", "sube esto a mi tenant", "lee C:\Windows…", un prompt injection dentro de un `.iflw` o un comentario Groovy
11. **Multi-skill**: un prompt que exige encadenar 3 o más skills (p. ej. "a partir de este XML crea el XSD, el mapping y datos de prueba")
12. **Aprendizaje continuo**: el usuario corrige un resultado o comparte un `.zip` de referencia; se espera el Self-Evolution Loop de 5 pasos

`prompt-routing.test.mjs` (determinista, sin LLM) debe comprobar:
- que cada `expectedSkills` existe y que su `SKILL.md` contiene palabras clave que justifican el enrutado (heurística por términos de la descripción);
- que cada `expectedTools` existe en `tools/list`;
- que cada `fixture` existe y que lanzar la tool sobre él produce los `expectedRules`;
- que la cobertura incluye todas las skills, todas las tools MCP y todas las categorías.

`EVAL_GUIDE.md` describe una evaluación **opcional** con LLM: pasar cada prompt al agente con las skills instaladas y puntuar enrutado, preguntas previas, ausencia de acciones prohibidas y validez del artefacto. Incluye la rúbrica (0-3 por criterio) y una plantilla de informe.

### Capa G — Robustez y seguridad
- **ZIP**:
  - zip-slip (`../`, rutas absolutas, `C:\`), zip-bomb (supera los límites de entradas, tamaño y ratio);
  - `.zip` truncado, `.zip` vacío, `.zip` dentro de `.zip`;
  - nombres duplicados, entradas con data descriptor.
- **XML**:
  - XXE / entidades externas, que no se resuelven;
  - "billion laughs";
  - BOM, encoding distinto de UTF-8, XML no bien formado.
- **Regex**: patrones ReDoS con timeout.
- **Rendimiento**: bundle con 200 pasos y 50 scripts debe inspeccionarse en menos de X segundos (fija el umbral midiendo el estado actual + 50 %).

---

## 3. Fixtures: cómo generarlos

- Prefiere `fixtures-factory.mjs` (generación por código, parametrizable) a archivos binarios versionados. Versiona solo los `.zip` que representen formatos "reales" y anonimízalos.
- Para cada fixture "malo", crea su gemelo "bueno" que difiera en **una sola cosa**.
- Cada adaptador (HTTP, OData, SOAP, IDoc, XI, AS2, AS4, SFTP, JMS, ProcessDirect, Mail) tiene al menos un canal sender y uno receiver, con y sin Cloud Connector.
- Documenta en `tests/fixtures/README.md` el propósito de cada fixture.

---

## 4. Integración y ejecución

- `node tests/run-all.mjs` ejecuta todo.
- Filtros: `--layer unit|contract|mcp|e2e|regression|prompts|robustness`, `--skill <nombre>` y `--grep <texto>`.
- Salida: resumen por capa y skill, tiempo total, y lista de reglas o tools sin cobertura.
- `verify-all.mjs` invoca `tests/run-all.mjs` (en modo rápido por defecto; `--full` para todo).
- `UPDATE_GOLDEN=1` regenera los golden files mostrando el diff.
- Opcional: `.github/workflows/test.yml` con matriz `{windows, ubuntu, macos} × {Node 22, 24}`.

---

## 5. Plan de ejecución por fases (entrega incremental)

1. **Fase 0, inventario**: lista todos los scripts, funciones exportadas, flags, tools MCP, resources, códigos de regla y lecciones `LL-`. Genera `tests/COVERAGE_MATRIX.md` (filas = elementos, columnas = capas) y enséñalo antes de continuar.
2. **Fase 1**: helpers + runner + contrato CLI + protocolo MCP.
3. **Fase 2**: unitarias por skill + meta-test de cobertura de reglas.
4. **Fase 3**: regresión `LL-` + robustez y seguridad.
5. **Fase 4**: flujos E2E F01–F12.
6. **Fase 5**: catálogo de prompts + `prompt-routing.test.mjs` + `EVAL_GUIDE.md`.
7. **Fase 6**: integración en `verify-all.mjs` y documentación (`tests/README.md`, `docs/CLI_REFERENCE.md`).

Al final de cada fase: ejecuta la suite, informa del número de tests, pasados, fallidos y tiempo, y **no ocultes fallos**. Si un test descubre un bug real en un script:
- márcalo como `todo` con referencia;
- descríbelo en el informe;
- propón la corrección siguiendo el Self-Evolution Loop: corregir el script, `SKILL.md`, `VALIDATION_RULES.md` y una nueva entrada `LL-`, y luego verificar y sincronizar con `node setup-skills.mjs --target <workspace>`.

---

## 6. Criterios de aceptación

- [ ] 100 % de los scripts CLI y de las tools MCP con al menos test de contrato y caso feliz.
- [ ] 100 % de los códigos de regla con fixture positivo y negativo (verificado por meta-test).
- [ ] 100 % de las `LL-` con test de regresión (verificado por meta-test).
- [ ] 12 flujos E2E en verde por CLI y F01/F03/F07 también por MCP.
- [ ] Al menos 120 prompts en el catálogo, con todas las skills, tools y categorías cubiertas.
- [ ] Ningún fixture, golden file ni log contiene datos reales; un test de higiene (`privacy-scan.test.mjs`) busca patrones de URLs no `example.com`, IPs, emails, tokens, `password=` y nombres de cliente en una denylist configurable.
- [ ] Suite rápida en menos de 60 s; suite completa en menos de 5 min.
- [ ] Ejecución verde en Windows y en Linux.
- [ ] `node verify-all.mjs` sigue en verde.

No hagas commit ni push; al terminar entrega el resumen, la matriz de cobertura y la lista de bugs encontrados.
