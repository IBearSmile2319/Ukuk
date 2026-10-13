import { Block, DetectDocumentTextCommand, TextractClient } from '@aws-sdk/client-textract';
import { OcrWord } from '../../engine/engine.types';
import { NoOcrProvider, OcrProvider } from './ocr.provider';
import { TesseractOcrProvider } from './tesseract.provider';

/** Formatos que DetectDocumentText acepta en modo síncrono (PDF: una página). */
const TEXTRACT_MIME = new Set(['image/jpeg', 'image/png', 'image/tiff', 'application/pdf']);

export function textractBlocksToWords(blocks: Block[]): OcrWord[] {
  return blocks
    .filter((b) => b.BlockType === 'WORD' && b.Text && b.Geometry?.BoundingBox)
    .map((b) => {
      const box = b.Geometry!.BoundingBox!;
      return {
        text: b.Text!,
        confidence: (b.Confidence ?? 0) / 100,
        page: b.Page ?? 1,
        bbox: { x: box.Left ?? 0, y: box.Top ?? 0, w: box.Width ?? 0, h: box.Height ?? 0 },
      };
    });
}

/** Amazon Textract. La región se acuerda con cada cliente (procesar fuera del Perú requiere autorización SBS). */
export class TextractOcrProvider implements OcrProvider {
  readonly name = 'textract';
  private readonly client: TextractClient;

  constructor(region: string) {
    this.client = new TextractClient({ region });
  }

  async extract(data: Buffer, mimeType: string): Promise<OcrWord[]> {
    if (!TEXTRACT_MIME.has(mimeType)) return [];
    const res = await this.client.send(new DetectDocumentTextCommand({ Document: { Bytes: data } }));
    return textractBlocksToWords(res.Blocks ?? []);
  }
}

/** UKUK_OCR=textract y AWS_REGION activan Textract; si no, no hay OCR. */
export function ocrProviderFromEnv(env: NodeJS.ProcessEnv = process.env): OcrProvider {
  if (env.UKUK_OCR === 'textract' && env.AWS_REGION) return new TextractOcrProvider(env.AWS_REGION);
  if (env.UKUK_OCR === 'tesseract') return new TesseractOcrProvider(env.UKUK_TESSERACT_BIN, env.UKUK_TESSERACT_LANG);
  return new NoOcrProvider();
}
