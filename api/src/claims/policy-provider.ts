import { Injectable, Logger } from '@nestjs/common';
import { parseCsv } from '../common/csv';
import { Queryable, many } from '../db/db.service';
import { PolicySourceConfig } from './claim-config';
import { Identifier, PolicySnapshot } from './conversation';
import { InsuranceLine } from './deadlines';

/** Consulta de pólizas del cliente: archivo diario (CSV) o su propia API. */
export interface PolicyProvider {
  lookup(db: Queryable, id: Identifier): Promise<PolicySnapshot[]>;
}

export function normalizeLine(s: string | undefined | null): InsuranceLine | null {
  const v = (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  if (['danos', 'dano', 'generales', 'patrimoniales'].includes(v)) return 'daños';
  if (['personas', 'vida', 'salud', 'accidentes'].includes(v)) return 'personas';
  return null;
}

const plateKey = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');

const SNAPSHOT_SQL = `SELECT policy_number, holder_name, holder_dni, plate, product, line,
  to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, notice_days, status
  FROM claim_policies`;

@Injectable()
export class CsvPolicyProvider implements PolicyProvider {
  async lookup(db: Queryable, id: Identifier): Promise<PolicySnapshot[]> {
    if (id.kind === 'dni') return many(db, `${SNAPSHOT_SQL} WHERE holder_dni = $1 ORDER BY end_date DESC NULLS LAST`, [id.value]);
    if (id.kind === 'placa') {
      return many(db, `${SNAPSHOT_SQL} WHERE regexp_replace(upper(plate), '[^A-Z0-9]', '', 'g') = $1 ORDER BY end_date DESC NULLS LAST`, [plateKey(id.value)]);
    }
    return many(db, `${SNAPSHOT_SQL} WHERE upper(policy_number) = upper($1)`, [id.value]);
  }
}

/**
 * API del cliente: GET {url}?tipo=dni|placa|poliza&valor=... → [{policy_number, holder_name, ...}]
 * (o {policies: [...]}). Solo https fuera de desarrollo.
 */
export class HttpPolicyProvider implements PolicyProvider {
  private readonly logger = new Logger(HttpPolicyProvider.name);

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(_db: Queryable, id: Identifier): Promise<PolicySnapshot[]> {
    const u = new URL(this.url);
    u.searchParams.set('tipo', id.kind);
    u.searchParams.set('valor', id.value);
    try {
      const res = await this.fetchImpl(u.toString(), {
        headers: { accept: 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`respondió ${res.status}`);
      const body = (await res.json()) as unknown;
      const list = Array.isArray(body) ? body : ((body as { policies?: unknown[] })?.policies ?? []);
      return list.flatMap((p) => {
        const s = toSnapshot(p as Record<string, unknown>);
        return s ? [s] : [];
      });
    } catch (err) {
      this.logger.warn(`Consulta de pólizas falló: ${(err as Error).message}`);
      return [];
    }
  }
}

function toSnapshot(r: Record<string, unknown>): PolicySnapshot | null {
  const str = (k: string) => (r[k] === undefined || r[k] === null || r[k] === '' ? null : String(r[k]));
  const line = normalizeLine(str('line'));
  const number = str('policy_number');
  const name = str('holder_name');
  if (!line || !number || !name) return null;
  const nd = Number(str('notice_days'));
  return {
    policy_number: number,
    holder_name: name,
    holder_dni: str('holder_dni'),
    plate: str('plate'),
    product: str('product'),
    line,
    start_date: str('start'),
    end_date: str('end'),
    notice_days: Number.isInteger(nd) && nd > 0 ? nd : null,
    status: str('status') ?? 'vigente',
  };
}

export function policyProviderFor(cfg: PolicySourceConfig, csv: CsvPolicyProvider): PolicyProvider {
  return cfg.type === 'http' ? new HttpPolicyProvider(cfg.url, cfg.token) : csv;
}

export interface PolicyRow extends PolicySnapshot {}

/** Archivo diario: policy_number, holder_dni, holder_name, plate, product, line, start, end, notice_days, status. */
export function parsePolicyCsv(csv: string): { rows: PolicyRow[]; errors: { line: number; error: string }[] } {
  const rows: PolicyRow[] = [];
  const errors: { line: number; error: string }[] = [];
  const date = (s: string) => (!s ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)?.slice(1).reverse().join('-') ?? 'x'));
  parseCsv(csv).forEach((r, i) => {
    const line = i + 2;
    const snap = toSnapshot({ ...r, start: undefined, end: undefined });
    if (!snap) return errors.push({ line, error: 'policy_number, holder_name y line (daños|personas) son obligatorios' });
    if (snap.holder_dni && !/^\d{8}$/.test(snap.holder_dni)) return errors.push({ line, error: 'holder_dni debe tener 8 dígitos' });
    const start = date(r.start ?? r.start_date ?? '');
    const end = date(r.end ?? r.end_date ?? '');
    if (start === 'x' || end === 'x') return errors.push({ line, error: 'fechas en formato YYYY-MM-DD o DD/MM/YYYY' });
    rows.push({ ...snap, plate: snap.plate ? snap.plate.toUpperCase() : null, start_date: start, end_date: end });
  });
  return { rows, errors };
}
