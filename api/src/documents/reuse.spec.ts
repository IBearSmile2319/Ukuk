import { numberTokens, sameNumbers } from './reuse';

const words = (s: string) => s.split(' ').map((text) => ({ text }));

describe('reuso por números', () => {
  const acta = numberTokens(words('ACTA N° 10042871 Fecha 15/03/2026 DNI 45678912 Inscripción 2026'));

  it('la misma acta, leída con algo de ruido, coincide', () => {
    const rescan = numberTokens(words('ACTA No 10042871 Fecha 15/03/2026 DNI 45678912 Inscripcion 2O26'));
    expect(sameNumbers(acta, rescan)).toBe(true);
  });

  it('otra acta del mismo formato no coincide aunque comparta el año', () => {
    const otra = numberTokens(words('ACTA N° 10099310 Fecha 02/11/2025 DNI 70011223 Inscripción 2026'));
    expect(sameNumbers(acta, otra)).toBe(false);
  });

  it('sin números suficientes no decide', () => {
    expect(sameNumbers(acta, numberTokens(words('BOLETA TOTAL 118.00')))).toBeNull();
  });
});
