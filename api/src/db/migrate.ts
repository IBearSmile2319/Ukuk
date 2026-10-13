import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Aplica en orden los archivos NNN_nombre.sql que aún no se aplicaron. */
export async function migrate(connectionString: string, log: (m: string) => void = () => {}) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`migración aplicada: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
