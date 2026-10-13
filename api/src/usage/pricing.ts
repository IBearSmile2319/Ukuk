import { ServiceModule } from '../tenancy/tenant';

/**
 * Lista de precios de referencia (soles, sin IGV). Son hipótesis para validar en
 * las entrevistas; cada cliente puede sobrescribirlas en settings.pricing.
 */
export const DEFAULT_PRICES = {
  documents: {
    unit: { extraction: 0.5, verification: 2.5, forensic: 5.0 } as Record<string, number>,
    monthlyMinimum: 1500,
  },
  regulatory: {
    plans: { alertas: 1200, impacto: 4500 } as Record<string, number>,
  },
  plaft: {
    unit: { onboarding_check: 1.5, monitored_record_month: 0.15 } as Record<string, number>,
    monthlyMinimum: 600,
  },
  claims: {
    unit: { claim: 20 } as Record<string, number>,
    /** Mensajes de WhatsApp: se trasladan al costo (USD) y se facturan aparte. */
    passthroughUsd: { whatsapp_message: 0.03 } as Record<string, number>,
  },
  bundle: { two: 0.1, threeOrMore: 0.2 },
};
export type PriceList = typeof DEFAULT_PRICES;

export interface UsageTotals {
  service: ServiceModule;
  unit: string;
  quantity: number;
}

export interface InvoiceLine {
  service: ServiceModule;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface MonthlyStatement {
  lines: InvoiceLine[];
  subtotal: number;
  bundleDiscountRate: number;
  bundleDiscount: number;
  total: number;
  passthroughUsd: { unit: string; quantity: number; amount: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeStatement(
  modules: ServiceModule[],
  usage: UsageTotals[],
  opts: { regulatoryPlan?: string; prices?: PriceList } = {},
): MonthlyStatement {
  const prices = opts.prices ?? DEFAULT_PRICES;
  const lines: InvoiceLine[] = [];
  const passthroughUsd: MonthlyStatement['passthroughUsd'] = [];
  const qty = (service: ServiceModule, unit: string) =>
    usage.filter((u) => u.service === service && u.unit === unit).reduce((s, u) => s + u.quantity, 0);

  const addMetered = (service: ServiceModule, table: Record<string, number>, minimum?: number) => {
    const start = lines.length;
    for (const [unit, price] of Object.entries(table)) {
      const q = qty(service, unit);
      if (q > 0) lines.push({ service, description: unit, quantity: q, unitPrice: price, amount: round2(q * price) });
    }
    const used = lines.slice(start).reduce((s, l) => s + l.amount, 0);
    if (minimum && used < minimum) {
      lines.push({
        service,
        description: 'ajuste a mínimo mensual',
        quantity: 1,
        unitPrice: round2(minimum - used),
        amount: round2(minimum - used),
      });
    }
  };

  if (modules.includes('documents')) addMetered('documents', prices.documents.unit, prices.documents.monthlyMinimum);
  if (modules.includes('regulatory')) {
    const plan = opts.regulatoryPlan ?? 'alertas';
    const price = prices.regulatory.plans[plan] ?? prices.regulatory.plans.alertas;
    lines.push({ service: 'regulatory', description: `suscripción ${plan}`, quantity: 1, unitPrice: price, amount: price });
  }
  if (modules.includes('plaft')) addMetered('plaft', prices.plaft.unit, prices.plaft.monthlyMinimum);
  if (modules.includes('claims')) {
    addMetered('claims', prices.claims.unit);
    for (const [unit, price] of Object.entries(prices.claims.passthroughUsd)) {
      const q = qty('claims', unit);
      if (q > 0) passthroughUsd.push({ unit, quantity: q, amount: round2(q * price) });
    }
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const n = modules.length;
  const bundleDiscountRate = n >= 3 ? prices.bundle.threeOrMore : n === 2 ? prices.bundle.two : 0;
  const bundleDiscount = round2(subtotal * bundleDiscountRate);
  return { lines, subtotal, bundleDiscountRate, bundleDiscount, total: round2(subtotal - bundleDiscount), passthroughUsd };
}
