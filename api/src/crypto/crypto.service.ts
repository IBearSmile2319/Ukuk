import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM. Formato: [versión(1)][iv(12)][tag(16)][cifrado]. */
export function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), enc]);
}

export function open(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed[0] !== VERSION) throw new Error('Versión de cifrado desconocida');
  const iv = sealed.subarray(1, 1 + IV_LEN);
  const tag = sealed.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
}

/**
 * Cifrado por sobre: cada cliente tiene su propia llave de datos (DEK), guardada
 * cifrada con la llave maestra. En AWS la llave maestra es una CMK de KMS por
 * cliente y `wrap`/`unwrap` pasan a ser GenerateDataKey/Decrypt.
 */
@Injectable()
export class CryptoService {
  private readonly cache = new Map<string, Buffer>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  newWrappedDataKey(tenantId: string): Buffer {
    return seal(this.config.masterKey, randomBytes(32), Buffer.from(tenantId));
  }

  dataKey(tenantId: string, wrapped: Buffer): Buffer {
    let key = this.cache.get(tenantId);
    if (!key) {
      key = open(this.config.masterKey, wrapped, Buffer.from(tenantId));
      this.cache.set(tenantId, key);
    }
    return key;
  }
}
