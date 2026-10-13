import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CryptoService, open, seal } from '../crypto/crypto.service';
import { Queryable, one } from '../db/db.service';
import { Tenant } from '../tenancy/tenant';
import { BLOB_STORE, BlobStore } from './blob-store';

export interface StoredBlob {
  id: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
}

/** Guarda archivos cifrados con la llave de datos del cliente. */
@Injectable()
export class BlobsService {
  constructor(
    @Inject(BLOB_STORE) private readonly store: BlobStore,
    private readonly crypto: CryptoService,
  ) {}

  async save(db: Queryable, tenant: Tenant, data: Buffer, mimeType: string, filename?: string): Promise<StoredBlob> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO blobs (tenant_id, sha256, mime_type, size_bytes, filename, storage_key)
       VALUES ($1,$2,$3,$4,$5,'') RETURNING id`,
      [tenant.id, sha256, mimeType, data.length, filename ?? null],
    );
    const id = row!.id;
    const key = `${tenant.id}/${id}`;
    const dek = this.crypto.dataKey(tenant.id, tenant.dataKeyEnc);
    await this.store.put(key, seal(dek, data, Buffer.from(id)));
    await db.query('UPDATE blobs SET storage_key = $2 WHERE id = $1', [id, key]);
    return { id, sha256, mimeType, sizeBytes: data.length, filename: filename ?? null };
  }

  async load(db: Queryable, tenant: Tenant, id: string): Promise<{ meta: StoredBlob; data: Buffer }> {
    const row = await one(db, 'SELECT * FROM blobs WHERE id = $1', [id]);
    if (!row) throw new NotFoundException('Archivo no encontrado');
    const dek = this.crypto.dataKey(tenant.id, tenant.dataKeyEnc);
    const data = open(dek, await this.store.get(row.storage_key), Buffer.from(id));
    return {
      meta: { id, sha256: row.sha256, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), filename: row.filename },
      data,
    };
  }
}
