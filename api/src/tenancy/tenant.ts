export const SERVICE_MODULES = ['documents', 'regulatory', 'plaft', 'claims'] as const;
export type ServiceModule = (typeof SERVICE_MODULES)[number];

export const ENTITY_TYPES = [
  'aseguradora',
  'corredor',
  'afocat',
  'banco',
  'caja',
  'cooperativa',
  'financiera',
  'fintech',
  'casa_cambio',
  'remesadora',
  'inmobiliaria',
  'notaria',
  'casino',
  'otro',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Tenant {
  id: string;
  name: string;
  ruc: string | null;
  entityType: EntityType;
  businessLines: string[];
  modules: ServiceModule[];
  dataKeyEnc: Buffer;
  settings: Record<string, unknown>;
}

export function rowToTenant(r: any): Tenant {
  return {
    id: r.id,
    name: r.name,
    ruc: r.ruc,
    entityType: r.entity_type,
    businessLines: r.business_lines,
    modules: r.modules,
    dataKeyEnc: r.data_key_enc,
    settings: r.settings ?? {},
  };
}
