import type { Request, Response } from 'express';
import { getIronSession, type SessionOptions } from 'iron-session';
import type { SessionUser } from './authz.js';

export interface UserSession {
  user?: SessionUser;
}

/** Transaction OIDC en cours (state, nonce, PKCE), durée de vie 10 minutes. */
export interface AuthTransaction {
  state?: string;
  nonce?: string;
  verifier?: string;
}

export type Sessions = ReturnType<typeof createSessions>;

/**
 * Sessions stockées dans des cookies chiffrés et signés (iron-session) : aucun jeton n'est
 * conservé, seule l'identité validée de l'utilisateur. SameSite=Lax est nécessaire pour le
 * retour de Microsoft Entra ID ; les requêtes d'écriture sont en plus protégées par
 * requireSameOrigin.
 */
export function createSessions(secret: string, secure: boolean) {
  const prefix = secure ? '__Host-' : '';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  const userOptions: SessionOptions = { password: secret, cookieName: `${prefix}rp_session`, ttl: 8 * 3600, cookieOptions };
  const txOptions: SessionOptions = { password: secret, cookieName: `${prefix}rp_auth`, ttl: 600, cookieOptions };

  return {
    user: (req: Request, res: Response) => getIronSession<UserSession>(req, res, userOptions),
    transaction: (req: Request, res: Response) => getIronSession<AuthTransaction>(req, res, txOptions),
  };
}
