# Plantilla Oficial de 8 Secciones para Documentación Técnica de iFlows (Modo 2)

> Esta plantilla es la del **Markdown** (validada con `--validate-doc`, DOC-001). El **PDF** (`--pdf`) tiene su propia estructura de 10 secciones con índice navegable: 1 Objetivo y alcance, 2 Arquitectura, 3 Pasos, 4 Endpoints y llamadas, 5 Contratos, 6 Scripts y mapeos, 7 Errores, 8 Parámetros, 9 Operación, 10 Supuestos y glosario.

Toda documentación técnica generada por ingeniería inversa debe contener **exactamente** estos 8 encabezados `##`:

```markdown
## 1. Resumen Ejecutivo
Propósito de negocio del flujo en 2-4 frases, dirigido a un Product Owner o líder funcional.

## 2. Arquitectura del Flujo
- Participantes (Sender / Receiver) y adaptadores utilizados (tipo, dirección, protocolo).
- Patrón de integración (síncrono Request-Reply, asíncrono, batch, event-driven).
- Secuencia paso a paso de Service Tasks, Call Activities, Routers, Content Modifiers y Script Tasks.

## 3. Parámetros y Configuración Externalizada
| Parámetro | Descripción Inferida | Valor por Defecto |
| :--- | :--- | :--- |

## 4. Scripts Groovy / Script Collection
Detalle de cada script detectado (`nombre.groovy`), propósito funcional, entradas/salidas en el `Message` y dependencias de Script Collection.

## 5. Manejo de Errores
- Presencia y comportamiento del `Exception Subprocess`.
- Comportamiento ante fallos en adaptadores síncronos.

## 6. Auditoría de Buenas Prácticas SAP (Hallazgos)
| Severidad (CRÍTICA/ALTA/MEDIA/LEVE) | Hallazgo | Componente Afectado | Recomendación |
| :--- | :--- | :--- | :--- |

## 7. Puntaje de Cumplimiento
Puntaje numérico `X/100` con desglose de deducciones (Crítica -30, Alta -15, Media -5, Baja -2).

## 8. Recomendaciones de Modernización
Lista priorizada de mejoras accionables en el SAP Integration Suite Designer.
```
