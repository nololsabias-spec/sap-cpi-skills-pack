# Regla de Aprendizaje Continuo y Privacidad — SAP CPI Skills Pack

Esta regla aplica siempre que trabajes con cualquiera de las 8 skills de SAP Cloud Integration (CPI / Integration Suite) o cuando el usuario pruebe, audite, corrija o despliegue artefactos (`.zip`, `.iflw`, `.groovy`, `.mmap`, `.xsd`, `.xsl`) en un tenant de SAP CPI.

## 1. Disparadores de Aprendizaje Continuo (Cuándo se activa)

Debes activar automáticamente el **Ciclo de Auto-Mejora (Self-Evolution Loop)** siempre que ocurra cualquiera de estos 3 eventos:
1. **Error en SAP CPI (Despliegue o Runtime)**: El usuario comparte un mensaje de error devuelto por SAP CPI al importar un `.zip` o al ejecutar un iFlow/Groovy/XSLT/XSD (ej. `MANIFEST.MF` inválido, `MissingMethodException`, `MultipleCompilationErrorsException`, fallo de adaptador o esquema).
2. **Corrección Manual o Mejora Técnica**: El usuario corrige un artefacto generado por la skill o señala una limitación/mejora respecto al comportamiento real de SAP Integration Suite.
3. **Inspección de iFlows o Script Collections de Referencia**: El usuario proporciona paquetes `.zip` reales como ejemplos para que las skills aprendan nuevos patrones arquitectónicos, convenciones o validaciones.

---

## 2. Protocolo Obligatorio de 5 Pasos (Self-Evolution Loop)

Cada vez que se active uno de los disparadores anteriores, ejecuta estos 5 pasos en orden sin necesidad de que el usuario te lo recuerde:

### Paso 1: Resolver el problema inmediato del usuario
- Corrige el script, el `.iflw`, el esquema o el paquete `.zip` del usuario y explícale de forma clara la causa raíz técnica.

### Paso 2: Abstracción y Privacidad Estricta (Zero Data Leakage)
- Extrae únicamente el principio técnico genérico de SAP CPI (API de Groovy 2.4, estructura OSGi, propiedades de BPMN2 `.iflw`, cabeceras Camel, etc.).
- **PROHIBICIÓN ABSOLUTA**: Nunca guardes ni subas a Git nombres de proyectos privados, nombres de clientes, URLs/endpoints reales, credenciales, contenido de archivos `.prop` ni payloads confidenciales. Tampoco leas ni imprimas valores de `parameters.prop`.

### Paso 3: Codificar la regla en los Scripts CLI Deterministas
- Si el hallazgo puede detectarse, prevenirse o autocorregirse mediante código, actualiza el script CLI correspondiente en `sap-cpi-skills-pack` (o en `.agents/skills/` si trabajas en modo standalone):
  - Errores de compilación/runtime Groovy 2.4 -> `skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs`
  - Auditoría de paquetes `.zip`, `.iflw`, `.mmap`, `.xsd` y autorremediación -> `skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs`
  - Empaquetado OSGi `MANIFEST.MF`, `.project` y generación de `.iflw` -> `skills/sap-cpi-architect/scripts/build-cpi-package.mjs` y `clone-iflow-bundle.mjs`
  - Inferencia/validación XSD -> `skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs`
  - Validación XSLT 1.0/2.0 -> `skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs`
  - Expresiones Regulares / Camel Simple -> `skills/sap-cpi-regex-studio/scripts/test-cpi-regex.mjs`
  - Suites de datos Mock E2E -> `skills/sap-cpi-mock-data-generator/scripts/validate-mock-suite.mjs`

### Paso 4: Actualizar `SKILL.md`, Referencias y `docs/LESSONS_LEARNED.md`
- Incorpora la regla o patrón arquitectónico en la `SKILL.md` correspondiente (y en sus archivos `references/` si aplica).
- Si añadiste un nuevo código de regla de validación, documéntalo en `docs/VALIDATION_RULES.md`.
- Añade una entrada anonimizada en `docs/LESSONS_LEARNED.md` con: ID (`LL-XXX`), síntoma/error en SAP CPI, causa raíz técnica, solución aplicada y archivos actualizados.

### Paso 5: Verificar y Sincronizar
- Ejecuta la suite de pruebas determinista:
  ```bash
  node verify-all.mjs
  ```
- Si existe el repositorio fuente `sap-cpi-skills-pack` en el workspace, sincroniza las skills actualizadas hacia `.agents/` y `.claude/` ejecutando:
  ```bash
  node setup-skills.mjs --target <ruta-workspace>
  ```
- Informa brevemente al usuario de qué regla o aprendizaje ha quedado incorporado en el proyecto para que no vuelva a ocurrir.
