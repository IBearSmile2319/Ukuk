import { OcrWord } from '../../engine/engine.types';

/** OCR con la posición de cada palabra, normalizada a 0..1. */
export interface OcrProvider {
  readonly name: string;
  /** Palabras reconocidas; [] si el formato no aplica. */
  extract(data: Buffer, mimeType: string): Promise<OcrWord[]>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

/** Sin OCR: el motor trabaja con los campos que envía el cliente y sus propias mediciones. */
export class NoOcrProvider implements OcrProvider {
  readonly name = 'none';

  async extract(): Promise<OcrWord[]> {
    return [];
  }
}
