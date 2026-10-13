import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { BLOB_STORE, LocalDiskBlobStore } from './blob-store';
import { BlobsService } from './blobs.service';

@Global()
@Module({
  providers: [
    {
      provide: BLOB_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new LocalDiskBlobStore(config.storageDir),
    },
    BlobsService,
  ],
  exports: [BlobsService, BLOB_STORE],
})
export class StorageModule {}
