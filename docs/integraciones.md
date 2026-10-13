# Integraciones: cómo activarlas y probarlas

Todo funciona sin integraciones: el motor mide, las reglas deciden y WhatsApp se prueba con el
simulador del portal. Cada integración se enciende con variables de entorno de la API o con la
configuración de cada cliente, y se puede activar una por una.

| Integración | Para qué | Cómo se activa | Costo para probar |
|---|---|---|---|
| OCR local (Tesseract) | Leer el texto de imágenes: verificación de diseño y plantillas | `brew install tesseract` + `UKUK_OCR=tesseract` | Gratis |
| Amazon Textract | OCR de producción, también para PDF escaneados | `UKUK_OCR=textract` + `AWS_REGION` + credenciales de AWS | Por página |
| Claude | Explicar hallazgos, resumir normas, revisar noticias negativas | `ANTHROPIC_API_KEY` | Por uso |
| WhatsApp Cloud API | Siniestros por WhatsApp de verdad | App de Meta + número + webhook | Número de prueba gratis |
| SUNAT | Validar comprobantes electrónicos | Credenciales de API SUNAT del cliente | Gratis |
| RENIEC | Validar DNI | Convenio del cliente | Según su convenio |
| Listas OFAC y ONU | PLAFT con listas reales | Un llamado de administración | Gratis |
| El Peruano y SBS | Radar con normas reales | `UKUK_REG_SOURCES` (después de pedir autorización) | Gratis |

Las variables van en el entorno de la API (ver `api/.env.example`). Para empezar: `./dev.sh` y,
en otra terminal, `node demo/seed.mjs`.

## OCR

- **Local:** `brew install tesseract` y la API con `UKUK_OCR=tesseract` (`./dev.sh` lo activa solo
  si encuentra Tesseract). Lee imágenes. Para PDF escaneados en local no hay OCR: el motor analiza
  igual su estructura.
- **Producción:** `UKUK_OCR=textract`, `AWS_REGION` y credenciales con permiso
  `textract:DetectDocumentText`. Confirma que Textract esté disponible en la región que acuerdes con
  el cliente: procesar fuera del Perú requiere autorización previa de la SBS.

## Claude

`ANTHROPIC_API_KEY=...` en el entorno de la API. Usa el modelo `claude-opus-5-5`.

- Nunca cambia el puntaje ni el veredicto: solo redacta.
- Lo que recibe: las mediciones y los hallazgos del documento (no la imagen), el texto de las normas
  (público) y, en PLAFT, el nombre de la persona con las noticias encontradas. Los hallazgos pueden
  incluir números de documento, así que para un cliente real esto es transferencia internacional de
  datos personales (Ley 29733): va en el contrato de encargo. Si el cliente exige que los datos no
  salgan de AWS, la alternativa es Claude en Amazon Bedrock.

## WhatsApp Cloud API

Sin cuenta de Meta: usa el **simulador** en el portal (Siniestros → Simulador). Es el flujo real
(estados, plazos SBS, página de captura de fotos, casos), solo que no envía nada a Meta.

Con un número de prueba de Meta:

1. En developers.facebook.com crea una app de tipo Business y agrégale el producto WhatsApp. Meta
   entrega un número de prueba, su *phone number ID* y un token temporal. Registra tu celular como
   destinatario de prueba.
2. Expón tu API local con un túnel: `cloudflared tunnel --url http://localhost:3000` (o
   `ngrok http 3000`). Usa la URL pública en `UKUK_PUBLIC_BASE_URL`: con ella se arman los enlaces
   de captura de fotos.
3. Variables de la API: `WHATSAPP_VERIFY_TOKEN` (una cadena que tú eliges), `WHATSAPP_APP_SECRET`
   (de la configuración básica de la app). Sin el *app secret*, el webhook rechaza todo, a propósito.
4. En la app de Meta, configura el webhook: URL `https://<tu-túnel>/webhooks/whatsapp`, el mismo
   verify token, y suscríbete al campo `messages`.
5. Asocia el número a tu cliente de prueba:

   ```bash
   curl -X POST localhost:3000/admin/claims/whatsapp-numbers -H 'x-admin-token: dev-admin-token' \
     -H 'content-type: application/json' \
     -d '{"tenant_id":"<id>","phone_number_id":"<phone number ID>","display_number":"+15550000000","secret_ref":"WHATSAPP_ACCESS_TOKEN"}'
   ```

   `secret_ref` es el nombre de la variable de entorno con el token, así no se guarda en la base.
6. Importa pólizas (Siniestros → Pólizas, o `demo/polizas.csv`) y escribe "Hola" desde tu celular.

Para un cliente real: el número y la cuenta de WhatsApp Business son de la aseguradora, verificados
a su nombre; Ukuk opera como proveedor tecnológico con un token permanente de usuario de sistema.
Los avisos fuera de la ventana de 24 horas necesitan plantillas aprobadas por Meta (pendiente).
Antes de cotizar, confirma en la página de precios de Meta la tarifa vigente para Perú.

## SUNAT: validez de comprobantes

El cliente genera credenciales de la API de consulta en SUNAT Operaciones en Línea, con su RUC y
clave SOL. Se guardan en la configuración del cliente. Guarda el secreto como variable de entorno y
referéncialo con `*_ref`, en vez de escribirlo en la base:

```bash
curl -X PATCH localhost:3000/admin/tenants/<id> -H 'x-admin-token: dev-admin-token' \
  -H 'content-type: application/json' \
  -d '{"settings":{"sunat":{"client_id":"<id>","client_secret_ref":"SUNAT_SECRET_CLIENTE_X","ruc":"<ruc del cliente>"}}}'
```

`PATCH settings` reemplaza todo el objeto `settings`: incluye ahí cualquier otra configuración que
ya tenga el cliente. El conector está escrito según el servicio documentado, pero **no se ha probado
contra SUNAT real**: es lo primero que hay que validar con un cliente piloto.

## RENIEC

Solo con el convenio del propio cliente (el convenio prohíbe revender datos). Configuración
`settings.reniec` con `dni_usuario`, `ruc_usuario` y `password_ref`. Del resultado solo se guarda
si los nombres coinciden, no los datos de la persona. Tampoco se ha probado contra el servicio real.

## Listas PLAFT reales

```bash
curl -X POST 'localhost:3000/admin/plaft/watchlists/sync' -H 'x-admin-token: dev-admin-token'
```

Descarga OFAC SDN (treasury.gov) y la lista consolidada de la ONU, y las carga en el motor. El
trabajo nocturno lo repite y vuelve a revisar las carteras monitoreadas cuando una lista cambia.
La lista de PEP peruanos no existe como fuente oficial: se carga como `ukuk_jsonl`
(`PUT /admin/plaft/watchlists/pep_pe?format=ukuk_jsonl&category=pep`), armada desde fuentes
públicas.

## Normas de El Peruano y SBS

Los adaptadores están apagados. Los términos de El Peruano no dicen nada sobre reutilización
comercial: pide autorización a Editora Perú antes de activar `UKUK_REG_SOURCES=el_peruano,sbs`.
Mientras tanto, las normas se cargan con `POST /admin/regulatory/norms` (ver `demo/normas.json`).
