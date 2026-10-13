import { buildSunatQuery } from './sunat.validator';

describe('buildSunatQuery', () => {
  it('arma la consulta desde los campos impresos', () => {
    expect(
      buildSunatQuery(
        { ruc_emisor: '20100047218', serie_numero: 'F001-00001234', fecha_emision: '2026-03-15', total: '118.00' },
        null,
      ),
    ).toEqual({
      numRuc: '20100047218',
      codComp: '01',
      numeroSerie: 'F001',
      numero: '1234',
      fechaEmision: '15/03/2026',
      monto: '118.00',
    });
    expect(buildSunatQuery({ ruc_emisor: '20100047218', serie_numero: 'B002-15', fecha_emision: '2026-01-02' }, null)?.codComp).toBe('03');
  });

  it('null si faltan datos', () => {
    expect(buildSunatQuery({ ruc_emisor: '20100047218' }, 'factura')).toBeNull();
  });
});
