import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Acceso a PostgreSQL con aislamiento por cliente.
 *
 * Las tablas de datos de clientes tienen Row Level Security forzada: solo ven las
 * filas cuyo tenant_id coincide con `app.tenant_id`. `withTenant` abre una
 * transacción y fija ese valor, así que un error de programación en una consulta
 * no puede filtrar datos de otro cliente.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  /** Consultas sobre tablas sin RLS (tenants, api_keys, catálogos compartidos). */
  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  async withTenant<T>(tenantId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export async function one<T extends QueryResultRow = any>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const res = await db.query<T>(sql, params);
  return res.rows[0];
}

export async function many<T extends QueryResultRow = any>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}
