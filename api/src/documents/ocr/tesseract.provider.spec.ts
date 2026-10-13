import { parseTesseractTsv } from './tesseract.provider';

describe('parseTesseractTsv', () => {
  it('normaliza las cajas con el tamaño de página y descarta filas vacías', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t',
      '4\t1\t1\t1\t1\t0\t100\t200\t300\t40\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t200\t150\t40\t96.5\tTOTAL',
      '5\t1\t1\t1\t1\t2\t300\t200\t100\t40\t95\t ',
    ].join('\n');
    expect(parseTesseractTsv(tsv)).toEqual([
      { text: 'TOTAL', confidence: 0.97, page: 1, bbox: { x: 0.1, y: 0.1, w: 0.15, h: 0.02 } },
    ]);
  });
});
