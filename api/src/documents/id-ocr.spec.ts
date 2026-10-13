import { OcrWord } from '../engine/engine.types';
import { dniFromOcr, mrzFromOcr } from './id-ocr';

/** Una palabra por elemento; cada arreglo es una línea, de arriba hacia abajo. */
const page = (...lines: string[][]): OcrWord[] =>
  lines.flatMap((line, y) => line.map((text, x) => ({ text, confidence: 0.9, page: 1, bbox: { x: 0.05 + x * 0.3, y: 0.1 + y * 0.06, w: 0.25, h: 0.04 } })));

// MRZ de especímenes ficticios (demo/), con sus dígitos de control correctos.
const DNIE = ['I<PER45678912<4<<<<<<<<<<<<<<<', '8506140F3403152PER<<<<<<<<<<<6', 'QUISPE<<ROSA<ELENA<<<<<<<<<<<<'].join('\n');
const AZUL = ['I<PER45678912<4<<<<<<<<<<<<<<<', '8506140F2603151PER<<<<<<<<<<<8', 'QUISPE<<ROSA<ELENA<<<<<<<<<<<<'].join('\n');

describe('MRZ desde el OCR', () => {
  it('reconstruye la MRZ con lo que leyó Tesseract en el espécimen (barra y espacio de más)', () => {
    const words = page(['Apellidos'], ['QUISPE', 'MAMANI'], ['I<PER4567/8912<4<<<<<<<<<<<<<<<'], ['8506140F3403152PER<<<<<<<<<<<6'], ['QUIS', 'PE<<ROSA<ELENA<<<<<<<<<<<<']);
    expect(mrzFromOcr(words)).toBe(DNIE);
  });

  it('corrige rellenos leídos como letras, la O por 0 y basura al final', () => {
    const words = page(['I<PER45678912<4<<<<<<<<Ke<<<<<<'], ['85O614OF26O3151PER<<<<<<<<<<<8'], ['QUISPE<<ROSA<ELENA<<<<<<<<<<<<¢']);
    expect(mrzFromOcr(words)).toBe(AZUL);
  });

  it('sin las tres líneas no inventa nada', () => {
    expect(mrzFromOcr(page(['PE<<ROSA<ELENA<<<<<<<<<<<<']))).toBeNull();
    expect(mrzFromOcr(page(['REPUBLICA', 'DEL', 'PERU']))).toBeNull();
  });

  it('número de DNI con su dígito, con o sin espacios', () => {
    expect(dniFromOcr(page(['CUI'], ['45678913-4']))).toBe('45678913-4');
    expect(dniFromOcr(page(['DNI', '45678912', '-', '4']))).toBe('45678912-4');
    expect(dniFromOcr(page(['4212341-9']))).toBeNull();
  });
});
