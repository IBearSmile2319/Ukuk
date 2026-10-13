# Desplegar Ukuk en un EC2

Una sola instancia con Docker: Caddy (HTTPS automático) delante de la API, que sirve la web. La
base de datos y el motor solo se ven dentro de la red de Docker.

```
Internet ──443──▶ Caddy ──▶ API + web ──▶ motor Rust
                                └──────▶ PostgreSQL
```

## 1. La instancia

| Qué | Recomendación |
|---|---|
| Tipo | `t4g.medium` (2 vCPU, 4 GB, ARM). Compilar el motor Rust y correr el OCR necesitan al menos 4 GB |
| Sistema | Amazon Linux 2023 o Ubuntu 24.04 |
| Disco | 30 GB gp3, **cifrado** |
| IP | Una IP elástica asociada a la instancia |
| Security group | Entrada 80 y 443 desde cualquier lugar; 22 solo desde tu IP. Nada más |
| Rol IAM | Solo si usarás Textract: permiso `textract:DetectDocumentText` (así no guardas llaves de AWS) |

Región: para pruebas da igual. Con datos de clientes supervisados por la SBS, procesar fuera del
Perú requiere su autorización; la región se acuerda con cada cliente.

## 2. Dominio

Crea un registro `A` (por ejemplo `ukuk.tudominio.pe`) que apunte a la IP elástica. Caddy pide
el certificado solo, la primera vez que arranca. Sin HTTPS no funcionan la cámara de la página de
captura ni el webhook de WhatsApp.

## 3. Preparar el servidor

```bash
# Amazon Linux 2023
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user   # sal y vuelve a entrar por SSH
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

git clone https://github.com/IBearSmile2319/Ukuk.git && cd Ukuk
```

## 4. Secretos

```bash
cp .env.prod.example .env
openssl rand -base64 32   # una vez por cada secreto
nano .env
```

| Variable | Qué es |
|---|---|
| `UKUK_DOMAIN` | El dominio del paso 2 |
| `UKUK_ADMIN_ALLOW` | Tu IP pública con `/32`. Sin esto, las rutas `/admin` quedan cerradas |
| `POSTGRES_PASSWORD`, `UKUK_APP_DB_PASSWORD` | Claves de la base |
| `UKUK_MASTER_KEY` | Cifra todos los documentos. **Guárdala también fuera del servidor**: sin ella no se recuperan |
| `UKUK_LINK_SECRET`, `UKUK_ADMIN_TOKEN` | Firma de enlaces de captura y token de administración |

`.env` está en `.gitignore`: nunca se sube.

## 5. Arrancar

```bash
docker compose -f docker-compose.prod.yml up -d --build      # la primera vez compila (~10–15 min)
docker compose -f docker-compose.prod.yml run --rm migrate   # crea las tablas y cambia la clave del rol de la app
curl https://ukuk.tudominio.pe/health                        # {"status":"ok",...}
```

Para cargar el cliente de demostración desde tu Mac (con tu IP en `UKUK_ADMIN_ALLOW`):

```bash
UKUK_API=https://ukuk.tudominio.pe UKUK_ADMIN_TOKEN=<el de .env> node demo/seed.mjs
```

## 6. Actualizar

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm migrate
```

## 7. Respaldos

- **Disco:** snapshots diarios del volumen EBS con Amazon Data Lifecycle Manager. Cubren la base y
  los documentos.
- **Base de datos**, además, un volcado diario a S3 (cron del servidor):

  ```bash
  docker compose -f docker-compose.prod.yml exec -T db pg_dump -U postgres -Fc ukuk \
    | aws s3 cp - s3://<tu-bucket>/ukuk-$(date +%F).dump
  ```

- **`UKUK_MASTER_KEY`**: en un gestor de contraseñas. Sin ella, los respaldos de documentos no
  sirven.

## Qué queda pendiente para producción con clientes

- Guardar los documentos en S3 con cifrado por cliente (hoy van al disco del servidor).
- Usuarios y roles en el portal (hoy se entra con la llave de API del cliente).
- Colas durables para el webhook de WhatsApp y la revisión masiva PLAFT.
- Los documentos reales de evaluación (`evaluacion/`) **no se suben al servidor** sin autorización.
