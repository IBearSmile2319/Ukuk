/** Tipos que acepta el servicio documental (además del ZIP para lotes, que se rechaza aparte). */
export const ACCEPTED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'application/pdf',
  'application/xml',
] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

/**
 * Detecta el tipo por los primeros bytes; el content-type que manda el cliente no es
 * confiable. Devuelve null si no se reconoce.
 */
export function sniffMime(data: Buffer): AcceptedMime | 'application/zip' | null {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'II*\x00' || ascii(0, 4) === 'MM\x00*') return 'image/tiff';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(ascii(8, 12))) return 'image/heic';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(0, 4) === 'PK\x03\x04') return 'application/zip';
  const head = data.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || /^<[A-Za-z_][\w:.-]*[\s>]/.test(head)) return 'application/xml';
  return null;
}
