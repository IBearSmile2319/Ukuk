import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * Quién hizo el cambio, para la auditoría. Los sistemas del cliente pueden enviar el
 * usuario final en `x-ukuk-user` (correo); si no, queda la llave de API.
 */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  const user = req.headers['x-ukuk-user'];
  if (typeof user === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(user)) return `user:${user.toLowerCase()}`;
  return req.tenant ? 'api_key' : 'admin';
});
