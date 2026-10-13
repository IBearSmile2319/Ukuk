import { computeDeadlines, deadlineAfter, limaDate, noticeDays } from './deadlines';

const lima = (s: string) => new Date(`${s}-05:00`);

describe('reloj legal del siniestro', () => {
  it('aviso: 3 días en daños, 7 en personas, salvo que la póliza dé más', () => {
    expect(noticeDays('daños')).toBe(3);
    expect(noticeDays('personas')).toBe(7);
    expect(noticeDays('daños', 10)).toBe(10);
    // Una póliza no puede dar menos plazo que la norma.
    expect(noticeDays('personas', 2)).toBe(7);
  });

  it('aviso vence al final del día 3 contado desde el día siguiente', () => {
    const d = computeDeadlines({ line: 'daños', occurredAt: lima('2026-10-01T22:00:00'), firstContactAt: lima('2026-10-04T23:59:00'), now: lima('2026-10-05T00:00:00') });
    expect(d.noticeDeadline?.toISOString()).toBe(lima('2026-10-04T23:59:59.999').toISOString());
    expect(d.lateNotice).toBe(false);
    const late = computeDeadlines({ line: 'daños', occurredAt: lima('2026-10-01T22:00:00'), firstContactAt: lima('2026-10-05T00:01:00'), now: lima('2026-10-05T00:01:00') });
    expect(late.lateNotice).toBe(true);
    const override = computeDeadlines({ line: 'daños', policyNoticeDays: 5, occurredAt: lima('2026-10-01T10:00:00'), firstContactAt: lima('2026-10-05T10:00:00'), now: lima('2026-10-05T10:00:00') });
    expect(override.lateNotice).toBe(false);
    expect(override.noticeDays).toBe(5);
  });

  it('sin documentación completa no corre el plazo de 30 días', () => {
    const d = computeDeadlines({ line: 'daños', firstContactAt: lima('2026-10-01T10:00:00'), now: lima('2026-12-01T10:00:00') });
    expect(d).toMatchObject({ consentDeadline: null, consented: false, canRequestClarification: true, alerts: [] });
  });

  describe('plazo de pronunciamiento', () => {
    const docs = lima('2026-10-01T15:00:00');
    const at = (s: string) => computeDeadlines({ line: 'personas', firstContactAt: docs, docsCompleteAt: docs, now: lima(s) });

    it('aclaraciones permitidas hasta el final del día 20', () => {
      expect(at('2026-10-21T23:59:00').canRequestClarification).toBe(true);
      expect(at('2026-10-21T23:59:00').dayCount).toBe(20);
      expect(at('2026-10-22T00:00:01').canRequestClarification).toBe(false);
    });

    it('alertas en los días 20, 25 y 28', () => {
      expect(at('2026-10-20T12:00:00').alerts).toEqual([]);
      expect(at('2026-10-21T00:00:00').alerts.map((a) => a.kind)).toEqual(['dia_20']);
      expect(at('2026-10-26T08:00:00').alerts.map((a) => a.kind)).toEqual(['dia_20', 'dia_25']);
      expect(at('2026-10-29T08:00:00').alerts.map((a) => a.kind)).toEqual(['dia_20', 'dia_25', 'dia_28']);
    });

    it('consentido al pasar el día 30 sin respuesta; pago en 30 días más', () => {
      const d30 = at('2026-10-31T23:59:00');
      expect(d30.consented).toBe(false);
      expect(d30.consentDeadline?.toISOString()).toBe(lima('2026-10-31T23:59:59.999').toISOString());
      const d31 = at('2026-11-01T00:00:01');
      expect(d31.consented).toBe(true);
      expect(d31.alerts.map((a) => a.kind)).toContain('consentido');
      expect(limaDate(d31.paymentDeadline!)).toBe('2026-11-30');
    });

    it('una decisión a tiempo evita el consentimiento y apaga las alertas', () => {
      const d = computeDeadlines({
        line: 'personas',
        firstContactAt: docs,
        docsCompleteAt: docs,
        decision: 'aprobado',
        decidedAt: lima('2026-10-10T10:00:00'),
        now: lima('2026-12-01T00:00:00'),
      });
      expect(d.consented).toBe(false);
      expect(d.alerts).toEqual([]);
      expect(limaDate(d.paymentDeadline!)).toBe('2026-11-09');
    });

    it('una decisión tardía no evita el consentimiento', () => {
      const d = computeDeadlines({
        line: 'personas',
        firstContactAt: docs,
        docsCompleteAt: docs,
        decision: 'rechazado',
        decidedAt: lima('2026-11-05T10:00:00'),
        now: lima('2026-11-06T00:00:00'),
      });
      expect(d.consented).toBe(true);
    });
  });

  it('deadlineAfter cruza el fin de mes y usa hora de Lima', () => {
    // 2026-01-31 23:00 en Lima ya es 1 de febrero en UTC.
    expect(limaDate(deadlineAfter(lima('2026-01-31T23:00:00'), 1))).toBe('2026-02-01');
  });
});
