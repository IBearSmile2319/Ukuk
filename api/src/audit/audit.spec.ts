import { auditHash, canonicalJson } from './audit.service';

describe('auditoría', () => {
  it('canonicalJson ordena llaves', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('el hash depende del eslabón anterior', () => {
    const e = { actor: 'api', action: 'x', entity: 'doc' };
    const h1 = auditHash(null, '2026-01-01T00:00:00.000Z', e);
    const h2 = auditHash(h1, '2026-01-01T00:00:00.000Z', e);
    expect(h1.equals(h2)).toBe(false);
    expect(auditHash(null, '2026-01-01T00:00:00.000Z', e).equals(h1)).toBe(true);
  });
});
