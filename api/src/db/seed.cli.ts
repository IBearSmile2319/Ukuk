import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/config';
import { TenantsService } from '../tenancy/tenants.service';

/** Crea un cliente de demostración con los cuatro servicios y muestra su llave. */
async function main() {
  const config = { ...loadConfig(), jobsEnabled: false };
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error'] });
  const tenants = app.get(TenantsService);
  const tenant = await tenants.create({
    name: process.argv[2] ?? 'Aseguradora Demo',
    entityType: 'aseguradora',
    businessLines: ['vehicular', 'salud', 'vida'],
    modules: ['documents', 'regulatory', 'plaft', 'claims'],
  });
  const key = await tenants.createApiKey(tenant.id, 'demo');
  console.log(JSON.stringify({ tenant_id: tenant.id, api_key: key.key }, null, 2));
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
