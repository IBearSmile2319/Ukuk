import { rateLimit } from './rate-limit';

describe('rateLimit', () => {
  it('corta al pasar el máximo por IP y se reinicia con la ventana', () => {
    let t = 0;
    const limit = rateLimit(2, 60_000, () => t);
    const call = (ip: string) => {
      let status = 200;
      const res: any = { setHeader: () => undefined, status: (s: number) => ((status = s), { json: () => undefined }) };
      limit({ ip } as any, res, () => undefined);
      return status;
    };
    expect([call('1.1.1.1'), call('1.1.1.1'), call('1.1.1.1')]).toEqual([200, 200, 429]);
    expect(call('2.2.2.2')).toBe(200);
    t = 61_000;
    expect(call('1.1.1.1')).toBe(200);
  });
});
