import { CsvHeaderError, parseCsv, parseSubjectsCsv } from './csv';

describe('CSV', () => {
  it('respeta comillas, comillas escapadas, saltos de línea y CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","di ""hola""\nadiós"\r\n\r\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'di "hola"\nadiós'],
      ['1', '2'],
    ]);
  });

  it('detecta punto y coma y quita el BOM', () => {
    expect(parseCsv('﻿name;kind\nJuan;individual')).toEqual([
      ['name', 'kind'],
      ['Juan', 'individual'],
    ]);
  });

  it('valida filas y reporta errores por línea', () => {
    const csv = [
      'name,kind,relation,doc_type,doc_number,birth_date,nationality',
      'Juan Pérez de la Cruz,individual,cliente,DNI,12345678,1970-02-03,pe',
      '"Constructora Andina, S.A.C.",entity,proveedor,RUC,20100047218,,',
      'Ana,individual,cliente,DNI,123,,',
      'Luis,individual,socio,DNI,87654321,,',
      'Rosa,individual,cliente,DNI,11112222,1990-02-31,',
      'Juan Pérez,individual,cliente,DNI,12345678,,',
    ].join('\n');
    const { subjects, errors } = parseSubjectsCsv(csv);
    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toEqual({
      line: 2,
      name: 'Juan Pérez de la Cruz',
      kind: 'individual',
      relation: 'cliente',
      doc_type: 'DNI',
      doc_number: '12345678',
      birth_date: '1970-02-03',
      nationality: 'PE',
      monitor: null,
    });
    expect(subjects[1].name).toBe('Constructora Andina, S.A.C.');
    expect(errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
    expect(errors[0].message).toMatch(/8 dígitos/);
    expect(errors[3].message).toMatch(/duplicada/);
  });

  it('exige la cabecera mínima', () => {
    expect(() => parseSubjectsCsv('name,kind\nx,individual')).toThrow(CsvHeaderError);
    expect(() => parseSubjectsCsv('')).toThrow(/vacío/);
  });
});
