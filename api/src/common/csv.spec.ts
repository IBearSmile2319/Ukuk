import { parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('lee comillas, separador ; y BOM', () => {
    const rows = parseCsv('﻿code;name;desc\nP1;"Política; PLAFT";"dice ""hola"""\r\n\n');
    expect(rows).toEqual([{ code: 'P1', name: 'Política; PLAFT', desc: 'dice "hola"' }]);
  });

  it('escribe y vuelve a leer', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 1]]);
    expect(parseCsv(csv)).toEqual([{ a: 'x,y', b: '1' }]);
  });
});
