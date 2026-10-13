import { DEFAULT_CLAIM_TYPES } from './claim-config';
import {
  CLAIM_NUMBER_TOKEN,
  ConversationState,
  Inbound,
  PolicySnapshot,
  StepContext,
  initialState,
  parseIdentifier,
  parseOccurrence,
  step,
} from './conversation';

const now = new Date('2026-10-13T20:00:00Z'); // 15:00 en Lima
const auto: PolicySnapshot = {
  policy_number: 'VEH-2026-001',
  holder_name: 'Juan Pérez',
  holder_dni: '12345678',
  plate: 'ABC-123',
  product: 'Auto Total',
  line: 'daños',
  start_date: '2026-01-01',
  end_date: '2026-12-31',
  notice_days: null,
  status: 'vigente',
};
const salud: PolicySnapshot = { ...auto, policy_number: 'SAL-9', product: 'Salud', line: 'personas', plate: null };

const baseCtx: StepContext = { now, tenantName: 'Seguros Andinos', claimTypes: DEFAULT_CLAIM_TYPES, photosCount: 0 };
const text = (t: string): Inbound => ({ kind: 'text', text: t });
const reply = (id: string): Inbound => ({ kind: 'reply', id, title: id });

function run(inputs: [Inbound, Partial<StepContext>?][], start: ConversationState = initialState()) {
  let state = start;
  const outs = [];
  const effects = [];
  for (const [input, ctx] of inputs) {
    const r = step(state, input, { ...baseCtx, ...ctx });
    state = r.state;
    outs.push(r.out);
    effects.push(r.effects);
  }
  return { state, outs, effects };
}

describe('parseIdentifier', () => {
  it.each([
    ['12345678', { kind: 'dni', value: '12345678' }],
    ['DNI 12345678', { kind: 'dni', value: '12345678' }],
    ['abc123', { kind: 'placa', value: 'ABC-123' }],
    ['A1B-234', { kind: 'placa', value: 'A1B-234' }],
    ['1234-ab', { kind: 'placa', value: '1234-AB' }],
    ['VEH-2026-001', { kind: 'poliza', value: 'VEH-2026-001' }],
    ['2001234567', { kind: 'poliza', value: '2001234567' }],
    ['1234567', { error: 'El DNI debe tener 8 dígitos.' }],
    ['hola', null],
  ])('%s', (input, expected) => {
    expect(parseIdentifier(input)).toEqual(expected);
  });
});

describe('parseOccurrence (hora de Lima)', () => {
  const iso = (t: string) => parseOccurrence(t, now)?.date.toISOString();
  it('hoy, ayer y fechas explícitas', () => {
    expect(iso('hoy 14:30')).toBe('2026-10-13T19:30:00.000Z');
    expect(iso('ayer a las 9 pm')).toBe('2026-10-13T02:00:00.000Z');
    expect(iso('12/10/2026 18:45')).toBe('2026-10-12T23:45:00.000Z');
    expect(iso('5/10 8am')).toBe('2026-10-05T13:00:00.000Z');
    expect(iso('12-10-26 7.15')).toBe('2026-10-12T12:15:00.000Z');
  });
  it('sin hora toma el mediodía y lo marca', () => {
    expect(parseOccurrence('ayer', now)).toEqual({ date: new Date('2026-10-12T17:00:00.000Z'), timeKnown: false });
  });
  it('fecha sin año en el futuro pasa al año anterior; inválidas → null', () => {
    expect(iso('20/12 10:00')).toBe('2025-12-20T15:00:00.000Z');
    expect(parseOccurrence('31/02/2026', now)).toBeNull();
    expect(parseOccurrence('no sé', now)).toBeNull();
    expect(parseOccurrence('hoy 25:00', now)).toBeNull();
  });
});

describe('máquina de estados', () => {
  it('flujo completo de choque leve con foto y documento', () => {
    const { state, outs, effects } = run([
      [text('Hola')],
      [text('12345678'), { lookup: [auto] }],
      [reply('tipo:choque_leve')],
      [text('hoy 14:30')],
      [{ kind: 'location', lat: -12.12, lng: -77.03, address: 'Av. Larco 100' }],
      [text('Me chocaron por detrás en un semáforo')],
      [reply('fotos:listo'), { photosCount: 2 }],
      [{ kind: 'media', media: 'image', fileId: 'f-lic', mimeType: 'image/jpeg' }, { photosCount: 2 }],
      [reply('confirmar'), { photosCount: 2 }],
    ]);
    expect(outs[0][0]).toMatchObject({ type: 'text', text: expect.stringContaining('Seguros Andinos') });
    expect(outs[1][0]).toMatchObject({ type: 'list', rows: expect.arrayContaining([{ id: 'tipo:choque_leve', title: 'Choque leve' }, { id: 'tipo:otro', title: 'Otro' }]) });
    // Solo tipos de la línea de la póliza (daños).
    expect((outs[1][0] as any).rows.map((r: any) => r.id)).not.toContain('tipo:reembolso_salud');
    expect(outs[5][0].type).toBe('capture_link');
    expect(effects[5]).toEqual([{ type: 'ensure_draft' }]);
    expect(outs[6][0]).toMatchObject({ type: 'buttons', text: expect.stringContaining('Licencia de conducir') });
    expect((outs[7][0] as any).text).toMatch(/Resumen:[\s\S]*Fecha: 13\/10\/2026 14:30[\s\S]*Fotos: 2[\s\S]*Documentos: 1 de 1/);
    expect((outs[8][0] as any).text).toContain(CLAIM_NUMBER_TOKEN);
    expect(effects[8]).toEqual([{ type: 'submit' }]);
    expect(state.step).toBe('registrado');
    expect(state.data).toMatchObject({
      policy: auto,
      claimType: 'choque_leve',
      occurredAt: '2026-10-13T19:30:00.000Z',
      location: { lat: -12.12, lng: -77.03, address: 'Av. Larco 100' },
      docs: [{ code: 'licencia_conducir', fileId: 'f-lic' }],
    });
    // Conversación corta: un mensaje de salida por paso.
    expect(outs.every((o) => o.length === 1)).toBe(true);
  });

  it('reembolso de salud: sin fotos, nota de voz y documento pendiente', () => {
    const { state, outs } = run([
      [text('hola')],
      [text('VEH-2026-001'), { lookup: [auto, salud] }],
      [reply('pol:SAL-9')],
      [text('reembolso de salud')],
      [text('ayer 10am')],
      [text('Clínica San Felipe, Jesús María')],
      [{ kind: 'media', media: 'audio', fileId: 'voz-1', mimeType: 'audio/ogg' }],
      [{ kind: 'media', media: 'document', fileId: 'boleta-1', mimeType: 'application/pdf' }],
      [reply('doc:despues')],
    ]);
    expect(outs[1][0].type).toBe('list');
    expect(state.step).toBe('confirmacion');
    expect(state.data.narrativeFileId).toBe('voz-1');
    expect(state.data.pendingDocs).toEqual(['informe_medico']);
    expect((outs[8][0] as any).text).toMatch(/Documentos: 1 de 2 \(pendiente: Informe médico\)/);
    expect((outs[8][0] as any).text).not.toMatch(/Fotos/);
  });

  it('valida DNI, póliza no encontrada y pasa a asesor tras 3 intentos', () => {
    const r = run([[text('hola')], [text('1234567')], [text('87654321'), { lookup: [] }], [text('???')]]);
    expect((r.outs[1][0] as any).text).toBe('El DNI debe tener 8 dígitos.');
    expect((r.outs[2][0] as any).text).toMatch(/No encontramos una póliza con 87654321/);
    expect(r.state.step).toBe('asesor');
    expect(r.effects[3]).toEqual([{ type: 'handoff', reason: 'intentos_fallidos' }]);
  });

  it('fotos: no avanza sin fotos', () => {
    const atPhotos: ConversationState = { step: 'fotos', data: { ...initialState().data, policy: auto, claimType: 'choque_leve' } };
    const r = step(atPhotos, text('listo'), baseCtx);
    expect(r.state.step).toBe('fotos');
    expect((r.out[0] as any).text).toMatch(/Aún no recibimos fotos/);
  });

  it('comandos: cancelar, ayuda, asesor y tipo fuera de alcance', () => {
    const mid: ConversationState = { step: 'fecha', data: { ...initialState().data, policy: auto, claimType: 'choque_leve' } };
    expect(step(mid, text('Ayuda'), baseCtx)).toMatchObject({ state: { step: 'fecha' }, effects: [] });
    expect(step(mid, text('CANCELAR'), baseCtx)).toMatchObject({ state: { step: 'cancelado' }, effects: [{ type: 'cancel' }] });
    expect(step(mid, text('asesor'), baseCtx)).toMatchObject({ state: { step: 'asesor' }, effects: [{ type: 'handoff', reason: 'pedido_del_cliente' }] });
    const atType: ConversationState = { step: 'tipo', data: { ...initialState().data, policy: auto } };
    expect(step(atType, reply('tipo:otro'), baseCtx)).toMatchObject({ state: { step: 'asesor' }, effects: [{ type: 'handoff', reason: 'tipo_no_atendido' }] });
  });

  it('fecha futura rechazada; estado terminal reinicia', () => {
    const mid: ConversationState = { step: 'fecha', data: { ...initialState().data, policy: auto, claimType: 'choque_leve' } };
    expect((step(mid, text('14/10/2026 10:00'), baseCtx).out[0] as any).text).toMatch(/no puede ser futura/);
    const done: ConversationState = { ...mid, step: 'registrado' };
    expect(step(done, text('hola'), baseCtx).state.step).toBe('identificacion');
  });

  it('no muta el estado recibido', () => {
    const s = initialState();
    step(s, text('hola'), baseCtx);
    expect(s.step).toBe('saludo');
  });
});
