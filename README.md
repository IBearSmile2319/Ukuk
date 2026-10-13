# Ukuk — antifraude y cumplimiento para seguros y banca en el Perú

Ukuk (oso de anteojos en quechua) es una plataforma multicliente con cuatro servicios que se
venden por separado o en paquete:

| # | Servicio | Qué hace | Módulo |
|---|---|---|---|
| 1 | **Verificación documental** | Puntaje de riesgo, datos extraídos e informe con cada hallazgo marcado sobre el documento (DNI, boletas, facturas, recibos, informes médicos…) | `documents` |
| 2 | **Radar regulatorio** | Normas nuevas (SBS, El Peruano…) conectadas a los procesos internos de cada cliente: matriz de impacto, tareas y plazos | `regulatory` |
| 3 | **PLAFT** | Revisión de clientes, proveedores y trabajadores contra OFAC, ONU, PEP y listas propias; casos, régimen de debida diligencia y revisión nocturna | `plaft` |
| 4 | **Siniestros por WhatsApp** | El asegurado reporta por chat, envía fotos con captura en vivo (GPS y hora) y el caso llega verificado al ajustador con el reloj SBS corriendo | `claims` |

La propuesta de negocio completa está en [`docs/propuesta.md`](docs/propuesta.md) y la
decisión de stack en [`docs/arquitectura.md`](docs/arquitectura.md). **Qué está hecho, cómo se
probó y qué sigue, con capturas: [`docs/roadmap.md`](docs/roadmap.md).** Cómo venderlo:
[`docs/venta.md`](docs/venta.md). Cómo activar OCR, Claude, WhatsApp, SUNAT y RENIEC:
[`docs/integraciones.md`](docs/integraciones.md).

## Estructura

```
engine/   Motor Rust (forense de imagen/PDF/XML, reglas peruanas, coincidencia de nombres)
api/      API NestJS multicliente (los 4 servicios, auditoría, cifrado, uso facturable)
web/      Página pública con demo + portal para analistas (React; la API la sirve en /)
demo/     Datos de demostración ficticios y script que los carga
docs/     Propuesta, arquitectura, venta, integraciones y contrato HTTP del motor
```

- **Rust** para lo pesado y determinista: ELA, copy‑move, dHash, calidad de imagen, MRZ del DNI,
  RUC, IGV, PDF/XML SUNAT y búsqueda de nombres peruanos (dos apellidos, tildes, partículas,
  errores de tipeo) con índice fonético. Ver [`engine/README.md`](engine/README.md).
- **TypeScript/NestJS** para la orquestación y lo que cambia por cliente.
- **PostgreSQL** con Row Level Security forzada: cada cliente solo ve sus filas.
- **Claude** (opcional, `ANTHROPIC_API_KEY`) redacta explicaciones, resume normas y juzga
  noticias negativas. Nunca cambia el puntaje ni el veredicto; sin llave, todo funciona con
  reglas deterministas.

## Correr en local

Requisitos: Docker, Rust, Node 22. Opcional: `brew install tesseract` (OCR local gratuito).

```bash
./dev.sh               # PostgreSQL en Docker; motor, API y web en tu máquina
node demo/seed.mjs     # en otra terminal: cliente de demostración con datos en los 4 servicios
```

Abre http://localhost:5173, entra al portal con la llave que imprime el script y prueba los cuatro
servicios. Siniestros trae un simulador de WhatsApp, así que no necesitas una cuenta de Meta.

Todo en Docker (la API sirve la web en http://localhost:3000):
`docker compose up -d db engine && docker compose run --rm migrate && docker compose up api`.

## Pruebas

```bash
cd engine && cargo test --workspace && cargo clippy --all-targets -- -D warnings
cd api && npx tsc --noEmit && npm test && npm run test:e2e   # e2e necesita PostgreSQL (TEST_PG_ADMIN_URL)
```

## Mapa de la API

| Ruta | Para qué |
|---|---|
| `POST /admin/tenants`, `POST /admin/tenants/:id/api-keys` | Alta de clientes y llaves (token de administración) |
| `GET /v1/account`, `/usage`, `/audit`, `/audit/verify` | Cuenta, consumo valorizado, auditoría |
| `/v1/documents`, `/v1/documents/templates` | Servicio 1: análisis, informe, revisión del analista, biblioteca de plantillas por emisor y versión |
| `/v1/regulatory/*`, `/admin/regulatory/*` | Servicio 2: normas, resumen diario, matriz de impacto, procesos, tareas, borrador de comentarios |
| `/v1/plaft/*`, `/admin/plaft/watchlists/*` | Servicio 3: sujetos, carga masiva CSV, casos y decisiones, re‑screening, reporte |
| `/webhooks/whatsapp`, `/capture/:token`, `/v1/claims/*` | Servicio 4: webhook firmado, página de captura en vivo, casos, alertas de plazos |
| `/v1/claims/simulator` | Simulador de WhatsApp para probar y hacer demos sin Meta |
| `POST /public/leads`, `GET /admin/leads` | Interesados que piden un piloto desde la página pública |

## Pendiente antes de producción

- Autorización de Editora Perú antes de activar los adaptadores de normas (están apagados).
- Probar los clientes de SUNAT (CPE) y RENIEC (PIDE) contra los servicios reales.
- Colas durables (SQS) para el webhook de WhatsApp y la revisión masiva PLAFT.
- Plantillas aprobadas de Meta para mensajes fuera de la ventana de 24 h; días hábiles y feriados
  en los plazos SBS; fuente real de noticias negativas; transcripción de notas de voz.
- Revisar el contrato laboral actual antes de vender a aseguradoras (ver riesgos en la propuesta).
