import { Global, Module } from '@nestjs/common';
import { AdminGuard, ApiKeyGuard } from './guards';
import { TenantsService } from './tenants.service';

@Global()
@Module({
  providers: [TenantsService, ApiKeyGuard, AdminGuard],
  exports: [TenantsService, ApiKeyGuard, AdminGuard],
})
export class TenancyModule {}
