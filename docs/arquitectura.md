# Arquitectura y decisión de stack

## Por qué dos lenguajes

| Pieza | Lenguaje | Motivo |
|---|---|---|
| Motor forense y de coincidencia de nombres (`engine/`) | **Rust** | Es la parte que hace cálculo pesado por cada documento (ELA, copy‑move, métricas de imagen, MRZ) y por cada consulta PLAFT (miles de nombres contra ~30 mil entradas, y la revisión nocturna de toda la cartera). Rust da latencia predecible, binario único que cabe en Lambda o en un contenedor pequeño, y es determinista: la misma imagen da siempre la misma medición, algo que exige el riesgo de modelo (Res. SBS 053‑2023). |
| API multicliente y orquestación (`api/`) | **TypeScript + NestJS** | Es tu stack. Aquí vive lo que cambia con cada cliente: contratos, permisos, flujos de siniestros, WhatsApp, normas, auditoría y cobro. El ecosistema de SDKs (AWS, Anthropic, WhatsApp) está en TypeScript. |
| Base de datos | **PostgreSQL** | Row Level Security para aislar clientes en la base misma, `jsonb` para hallazgos, búsqueda de texto en español para normas, `bit_count` para comparar huellas de imagen. |
| UI (siguiente fase) | **Next.js + React** | Portal del analista y del oficial de cumplimiento, visor del informe con el "inspector araña" sobre el documento. Comparte tipos con la API. |

No usamos Python: el único punto donde destacaría (visión por computadora) lo cubre el motor
Rust para las mediciones deterministas, y el OCR va por Amazon Textract.

## Principios que vienen de la norma

- **El modelo no decide solo.** Las capas deterministas (motor Rust) miden; Claude, cuando está
  activado, solo redacta la explicación a partir de esas mediciones. El puntaje y el veredicto
  salen de una función pura y auditable (`api/src/documents/…scoring`).
- **Aislamiento por cliente** en tres niveles: RLS forzada en PostgreSQL (la app se conecta con un
  rol sin privilegios y cada transacción fija `app.tenant_id`), una llave de datos por cliente
  para cifrar archivos (AES‑256‑GCM, cifrado por sobre; en AWS pasa a ser KMS) y llaves de API por
  cliente guardadas solo como hash.
- **Auditoría inalterable:** `audit_log` encadenado por SHA‑256 por cliente, con un trigger que
  bloquea UPDATE y DELETE. `GET /v1/account/audit/verify` recalcula la cadena.
- **Región de procesamiento por contrato:** nada en el código asume una región; procesar fuera del
  Perú requiere autorización de la SBS (Res. SBS 272‑2017).
- **RENIEC con el convenio del cliente:** las credenciales viven en la configuración de cada cliente;
  Ukuk no revende acceso.

## Flujo de un documento

```
cliente ──POST /v1/documents──▶ API
                                 ├─ guarda el archivo cifrado (llave del cliente)
                                 ├─ OCR (Textract) → palabras con posición
                                 ├─ elige plantilla por emisor + versión + fecha del documento
                                 ├─ motor Rust /v1/analyze → mediciones + hallazgos
                                 ├─ validaciones externas (SUNAT, RENIEC, RUC)
                                 ├─ reuso: huella dHash contra el historial del cliente
                                 ├─ puntaje + veredicto (función pura)
                                 └─ auditoría + uso facturable (misma transacción)
```

## Despliegue objetivo en AWS (serverless)

- API en Lambda (o ECS Fargate) detrás de API Gateway; motor Rust en Lambda con imagen de contenedor.
- Colas SQS + Step Functions para documentos pesados y la revisión nocturna PLAFT.
- S3 con SSE‑KMS por cliente para archivos; RDS PostgreSQL con cifrado.
- Textract para OCR; Claude vía API de Anthropic o Claude en Amazon Bedrock si el cliente exige
  que los datos no salgan de AWS.
