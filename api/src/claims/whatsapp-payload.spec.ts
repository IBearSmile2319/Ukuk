import { parseWebhookPayload } from './whatsapp-payload';

const wrap = (messages: any[]) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '51999000111', phone_number_id: 'PN1' },
            contacts: [{ profile: { name: 'Juan' }, wa_id: '51987654321' }],
            messages,
          },
        },
      ],
    },
  ],
});

describe('payload del webhook de Meta', () => {
  it('texto, botón, lista, ubicación e imagen', () => {
    const base = { from: '51987654321', timestamp: '1760371200' };
    const msgs = parseWebhookPayload(
      wrap([
        { ...base, id: 'w1', type: 'text', text: { body: 'hola' } },
        { ...base, id: 'w2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirmar', title: 'Confirmar' } } },
        { ...base, id: 'w3', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'tipo:robo_celular', title: 'Robo' } } },
        { ...base, id: 'w4', type: 'location', location: { latitude: -12.1, longitude: -77.0, name: 'Casa' } },
        { ...base, id: 'w5', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'choque' } },
        { ...base, id: 'w6', type: 'reaction', reaction: { emoji: 'x' } },
      ]),
    );
    expect(msgs.map((m) => m.input.kind)).toEqual(['text', 'reply', 'reply', 'location', 'media', 'unsupported']);
    expect(msgs[0]).toMatchObject({ phoneNumberId: 'PN1', from: '51987654321', profileName: 'Juan', wamid: 'w1', body: 'hola' });
    expect(msgs[0].timestamp.toISOString()).toBe('2025-10-13T16:00:00.000Z');
    expect(msgs[4].media).toEqual({ id: 'MEDIA1', kind: 'image', mimeType: 'image/jpeg', caption: 'choque', filename: undefined });
  });

  it('ignora estados de entrega y objetos ajenos', () => {
    expect(parseWebhookPayload({ object: 'page', entry: [] })).toEqual([]);
    const statuses = wrap([]);
    statuses.entry[0].changes[0].value.messages = undefined as any;
    expect(parseWebhookPayload(statuses)).toEqual([]);
  });
});
