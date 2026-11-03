import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/**
 * Protection CSRF des requêtes d'écriture : en-tête personnalisé (impose un preflight CORS,
 * que nous n'autorisons pas) et vérification de l'origine.
 */
export function requireSameOrigin(publicBaseUrl: string): RequestHandler {
  const origin = new URL(publicBaseUrl).origin;
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const requestOrigin = req.get('origin');
    if (req.get('x-requested-with') !== 'XMLHttpRequest' || (requestOrigin && requestOrigin !== origin)) {
      res.status(403).json({ error: 'Requête refusée.' });
      return;
    }
    next();
  };
}
