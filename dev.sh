#!/usr/bin/env bash
# Entorno local para probar: PostgreSQL en Docker; motor, API y web en tu máquina.
# Uso: ./dev.sh          (luego, en otra terminal: node demo/seed.mjs)
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d --wait db
[ -d api/node_modules ] || npm --prefix api ci
[ -d web/node_modules ] || npm --prefix web ci
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ukuk npm --prefix api run -s migrate
cargo build --release -q --manifest-path engine/Cargo.toml -p ukuk-engine

trap 'kill 0' EXIT
UKUK_DATA_DIR=var/engine engine/target/release/ukuk-engine &
(cd api && DATABASE_URL=postgres://ukuk_app:ukuk@localhost:5432/ukuk \
  UKUK_OCR="$(command -v tesseract >/dev/null && echo tesseract || true)" npm run -s dev) &
npm --prefix web run dev -- --open &
echo "API http://localhost:3000 · Web http://localhost:5173 · datos de prueba: node demo/seed.mjs"
wait
