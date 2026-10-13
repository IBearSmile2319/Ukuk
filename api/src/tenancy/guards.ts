import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ServiceModule, Tenant } from './tenant';
import { TenantsService } from './tenants.service';

const MODULE_KEY = 'ukuk:module';

/** Exige que el contrato del cliente tenga activo este servicio. */
export const RequireModule = (module: ServiceModule) => SetMetadata(MODULE_KEY, module);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Tenant => ctx.switchToHttp().getRequest().tenant,
);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly tenants: TenantsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['x-api-key'] ?? '';
    const bearer = /^Bearer (.+)$/i.exec(req.headers['authorization'] ?? '')?.[1];
    const key = (typeof header === 'string' && header) || bearer;
    if (!key) throw new UnauthorizedException('Falta la llave de API (x-api-key)');
    const tenant = await this.tenants.findByApiKey(key);
    if (!tenant) throw new UnauthorizedException('Llave de API inválida o revocada');
    const module = this.reflector.getAllAndOverride<ServiceModule | undefined>(MODULE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (module && !tenant.modules.includes(module)) {
      throw new ForbiddenException(`El servicio "${module}" no está activo en su contrato`);
    }
    req.tenant = tenant;
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest().headers['x-admin-token'];
    const expected = Buffer.from(this.config.adminToken);
    const got = Buffer.from(typeof token === 'string' ? token : '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      throw new UnauthorizedException('Token de administración inválido');
    }
    return true;
  }
}
