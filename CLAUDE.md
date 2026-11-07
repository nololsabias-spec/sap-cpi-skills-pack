# AI Agent Harness — SAP CPI Skills Pack (`CLAUDE.md`)

Consulta y sigue estrictamente las directrices definidas en [`AGENTS.md`](./AGENTS.md) y en [`rules/sap-cpi-continuous-learning.md`](./rules/sap-cpi-continuous-learning.md).

## Resumen de Reglas Críticas

1. **Aprendizaje Continuo Automático**: Cuando el usuario reporte un fallo de subida/ejecución en SAP CPI, corrija un resultado o comparta un paquete `.zip` de ejemplo, tras resolver su tarea inmediata debes:
   - Abstraer la regla técnica genérica sin ningún dato privado.
   - Codificar la validación o mejora en el script CLI correspondiente (`skills/*/scripts/*.mjs`).
   - Actualizar la `SKILL.md` implicada, `docs/VALIDATION_RULES.md` y `docs/LESSONS_LEARNED.md`.
   - Ejecutar `node verify-all.mjs` y `node setup-skills.mjs`.
2. **Privacidad Estricta**: Nunca leas ni imprimas valores de archivos `.prop`, y jamás incluyas nombres de proyectos privados, clientes ni endpoints reales en las skills, tests o commits.
3. **Limpieza Reversible de Bundles Reales** ([`rules/sap-cpi-privacy-sanitize.md`](./rules/sap-cpi-privacy-sanitize.md)): antes de leer un `.zip`/`.iflw` exportado de un tenant, pregunta si limpiarlo; trabaja solo con el `.sanitized.zip`, no leas nunca el `*.sanitize-map.json` y recuerda restaurar (`--restore`) antes de importar en SAP CPI.
