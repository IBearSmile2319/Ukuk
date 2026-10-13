import { spawn } from 'node:child_process';
import { OcrWord } from '../../engine/engine.types';
import { OcrProvider } from './ocr.provider';

const IMAGE = /^image\/(jpeg|png|tiff|webp)$/;

/** TSV de Tesseract → palabras con caja normalizada (la fila de nivel 1 trae el tamaño de página). */
export function parseTesseractTsv(tsv: string): OcrWord[] {
  let pageW = 0;
  let pageH = 0;
  const words: OcrWord[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12) continue;
    const [level, page, , , , , left, top, width, height, conf] = c.slice(0, 11).map(Number);
    const text = c.slice(11).join('\t').trim();
    if (level === 1) [pageW, pageH] = [width, height];
    if (level !== 5 || !text || conf < 0 || !pageW || !pageH) continue;
    words.push({
      text,
      confidence: Math.round(conf) / 100,
      page,
      bbox: { x: left / pageW, y: top / pageH, w: width / pageW, h: height / pageH },
    });
  }
  return words;
}

/**
 * OCR local y gratuito para probar sin AWS (`brew install tesseract`). Solo imágenes:
 * para PDF escaneados en producción va Textract.
 */
export class TesseractOcrProvider implements OcrProvider {
  readonly name = 'tesseract';

  constructor(
    private readonly bin = 'tesseract',
    private readonly lang = 'eng',
  ) {}

  async extract(data: Buffer, mimeType: string): Promise<OcrWord[]> {
    if (!IMAGE.test(mimeType)) return [];
    const tsv = await new Promise<string>((resolve, reject) => {
      const p = spawn(this.bin, ['stdin', 'stdout', '-l', this.lang, 'tsv'], { timeout: 60_000 });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract salió con ${code}: ${err.trim()}`))));
      p.stdin.end(data);
    });
    return parseTesseractTsv(tsv);
  }
}
