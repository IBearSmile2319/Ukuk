import { computeStatement } from './pricing';

describe('computeStatement', () => {
  it('aplica el mínimo mensual del servicio documental', () => {
    const s = computeStatement(['documents'], [{ service: 'documents', unit: 'verification', quantity: 100 }]);
    expect(s.subtotal).toBe(1500);
    expect(s.lines.map((l) => l.description)).toEqual(['verification', 'ajuste a mínimo mensual']);
    expect(s.bundleDiscountRate).toBe(0);
  });

  it('descuento de paquete con tres servicios', () => {
    const s = computeStatement(
      ['documents', 'plaft', 'claims'],
      [
        { service: 'documents', unit: 'forensic', quantity: 400 },
        { service: 'plaft', unit: 'onboarding_check', quantity: 500 },
        { service: 'claims', unit: 'claim', quantity: 100 },
        { service: 'claims', unit: 'whatsapp_message', quantity: 2000 },
      ],
    );
    expect(s.subtotal).toBe(2000 + 750 + 2000);
    expect(s.bundleDiscountRate).toBe(0.2);
    expect(s.total).toBe(3800);
    expect(s.passthroughUsd).toEqual([{ unit: 'whatsapp_message', quantity: 2000, amount: 60 }]);
  });
});
