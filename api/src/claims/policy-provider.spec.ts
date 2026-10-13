import { HttpPolicyProvider, normalizeLine, parsePolicyCsv } from './policy-provider';

describe('pólizas', () => {
  it('lee el CSV diario con errores por fila', () => {
    const { rows, errors } = parsePolicyCsv(
      [
        'policy_number,holder_dni,holder_name,plate,product,line,start,end,notice_days,status',
        'VEH-1,12345678,Juan Pérez,abc-123,Auto,daños,2026-01-01,31/12/2026,5,vigente',
        'SAL-1,1234,Ana,,Salud,personas,,,,',
        'X-1,,Sin línea,,,otra,,,,',
      ].join('\n'),
    );
    expect(rows).toEqual([
      expect.objectContaining({ policy_number: 'VEH-1', plate: 'ABC-123', line: 'daños', start_date: '2026-01-01', end_date: '2026-12-31', notice_days: 5 }),
    ]);
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(normalizeLine('Danos')).toBe('daños');
    expect(normalizeLine('vida')).toBe('personas');
  });

  it('HttpPolicyProvider consulta la API del cliente y tolera fallas', async () => {
    const calls: string[] = [];
    const ok = new HttpPolicyProvider('https://api.aseg.pe/polizas', 'tok', (async (url: string, init: any) => {
      calls.push(url);
      expect(init.headers.authorization).toBe('Bearer tok');
      return new Response(JSON.stringify({ policies: [{ policy_number: 'P1', holder_name: 'Ana', line: 'personas' }, { bad: 1 }] }));
    }) as any);
    const res = await ok.lookup({} as any, { kind: 'dni', value: '12345678' });
    expect(calls[0]).toBe('https://api.aseg.pe/polizas?tipo=dni&valor=12345678');
    expect(res).toEqual([expect.objectContaining({ policy_number: 'P1', line: 'personas', status: 'vigente' })]);
    const down = new HttpPolicyProvider('https://x.pe', undefined, (async () => new Response('', { status: 500 })) as any);
    expect(await down.lookup({} as any, { kind: 'poliza', value: 'P1' })).toEqual([]);
  });
});
