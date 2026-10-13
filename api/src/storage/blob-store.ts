import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Almacenamiento de objetos. LocalDisk para desarrollo; en AWS, S3 con SSE-KMS. */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export const BLOB_STORE = Symbol('BLOB_STORE');

export class LocalDiskBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('Llave de blob inválida');
    return join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
