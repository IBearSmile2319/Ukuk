import { sniffMime } from './file-type';

describe('sniffMime', () => {
  it('reconoce los formatos aceptados', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('\x89PNG\r\n\x1a\nxxxx', 'latin1'))).toBe('image/png');
    expect(sniffMime(Buffer.from('RIFF0000WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffMime(Buffer.from('II*\x00xxxx', 'latin1'))).toBe('image/tiff');
    expect(sniffMime(Buffer.from('\x00\x00\x00\x18ftypheic0000', 'latin1'))).toBe('image/heic');
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('PK\x03\x04xx', 'latin1'))).toBe('application/zip');
    expect(sniffMime(Buffer.from('﻿<?xml version="1.0"?><Invoice/>'))).toBe('application/xml');
    expect(sniffMime(Buffer.from('<Invoice xmlns="x"></Invoice>'))).toBe('application/xml');
  });

  it('devuelve null para lo desconocido', () => {
    expect(sniffMime(Buffer.from('hola mundo'))).toBeNull();
  });
});
