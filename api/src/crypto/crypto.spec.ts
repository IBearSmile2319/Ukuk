import { randomBytes } from 'node:crypto';
import { open, seal } from './crypto.service';

describe('seal/open', () => {
  const key = randomBytes(32);

  it('cifra y descifra', () => {
    const msg = Buffer.from('boleta de pago');
    expect(open(key, seal(key, msg)).toString()).toBe('boleta de pago');
  });

  it('rechaza datos alterados', () => {
    const sealed = seal(key, Buffer.from('x'));
    sealed[sealed.length - 1] ^= 1;
    expect(() => open(key, sealed)).toThrow();
  });

  it('rechaza otra llave o AAD distinto', () => {
    const sealed = seal(key, Buffer.from('x'), Buffer.from('tenant-a'));
    expect(() => open(randomBytes(32), sealed, Buffer.from('tenant-a'))).toThrow();
    expect(() => open(key, sealed, Buffer.from('tenant-b'))).toThrow();
  });
});
