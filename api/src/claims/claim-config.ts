import { DocumentType } from '../engine/engine.types';
import { InsuranceLine } from './deadlines';

export interface RequiredDoc {
  code: string;
  label: string;
  /** Tipo que se le pasa al motor para la verificación documental. */
  engine_type?: DocumentType;
}

export interface ClaimTypeConfig {
  code: string;
  label: string;
  line: InsuranceLine;
  /** Pide fotos por el enlace de captura en vivo. */
  photos: boolean;
  required_docs: RequiredDoc[];
}

export type DestinationConfig =
  | { type: 'none' }
  | { type: 'webhook'; url: string; secret: string }
  | { type: 'email'; to: string[] };

export type PolicySourceConfig = { type: 'csv' } | { type: 'http'; url: string; token?: string };

export interface ClaimsConfig {
  claim_types: ClaimTypeConfig[];
  destination: DestinationConfig;
  policy_source: PolicySourceConfig;
  /** Distancia máxima entre la foto y el lugar declarado antes de marcarla. */
  gps_max_km: number;
  /** Desfase máximo aceptado entre el reloj del celular y el del servidor. */
  max_clock_drift_minutes: number;
  capture_ttl_hours: number;
  /** Tope de mensajes entrantes por conversación antes de pasar a un asesor. */
  max_inbound_messages: number;
}

export const DEFAULT_CLAIM_TYPES: ClaimTypeConfig[] = [
  {
    code: 'choque_leve',
    label: 'Choque leve',
    line: 'daños',
    photos: true,
    required_docs: [{ code: 'licencia_conducir', label: 'Licencia de conducir', engine_type: 'other' }],
  },
  {
    code: 'robo_celular',
    label: 'Robo de celular',
    line: 'daños',
    photos: false,
    required_docs: [{ code: 'denuncia_policial', label: 'Denuncia policial', engine_type: 'acta' }],
  },
  {
    code: 'reembolso_salud',
    label: 'Reembolso de salud',
    line: 'personas',
    photos: false,
    required_docs: [
      { code: 'boleta', label: 'Boleta o factura', engine_type: 'boleta_venta' },
      { code: 'informe_medico', label: 'Informe médico', engine_type: 'informe_medico' },
    ],
  },
];

export const DEFAULT_CLAIMS_CONFIG: ClaimsConfig = {
  claim_types: DEFAULT_CLAIM_TYPES,
  destination: { type: 'none' },
  policy_source: { type: 'csv' },
  gps_max_km: 5,
  max_clock_drift_minutes: 10,
  capture_ttl_hours: 24,
  max_inbound_messages: 30,
};

export function mergeConfig(stored: Partial<ClaimsConfig> | null | undefined): ClaimsConfig {
  return { ...DEFAULT_CLAIMS_CONFIG, ...(stored ?? {}) };
}

/** Oculta secretos al devolver la configuración. */
export function publicConfig(c: ClaimsConfig): ClaimsConfig {
  const destination = c.destination.type === 'webhook' ? { ...c.destination, secret: '***' } : c.destination;
  const policy_source = c.policy_source.type === 'http' && c.policy_source.token ? { ...c.policy_source, token: '***' } : c.policy_source;
  return { ...c, destination, policy_source };
}
