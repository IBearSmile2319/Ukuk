import type { NextFunction, Request, Response } from 'express';

/**
 * Límite por IP para las rutas públicas (formulario de piloto, página de captura).
 * ponytail: en memoria y por proceso; con varias instancias, moverlo al balanceador o a Redis.
 */
export function rateLimit(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    if (hits.size > 10_000) for (const [ip, h] of hits) if (h.reset < t) hits.delete(ip);
    const key = req.ip ?? 'desconocida';
    const h = hits.get(key);
    if (!h || h.reset < t) {
      hits.set(key, { n: 1, reset: t + windowMs });
      return next();
    }
    if (++h.n > max) {
      res.setHeader('retry-after', String(Math.ceil((h.reset - t) / 1000)));
      res.status(429).json({ statusCode: 429, message: 'Demasiadas solicitudes; intente de nuevo en un minuto.' });
      return;
    }
    next();
  };
}
