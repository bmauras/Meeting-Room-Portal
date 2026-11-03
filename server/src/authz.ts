import { isEmail } from './rules.js';

export const REQUIRED_ROLE = 'Room.Booker';

export interface IdTokenClaims {
  oid?: string;
  tid?: string;
  idp?: string;
  acct?: number;
  roles?: string[];
  name?: string;
  email?: string;
  preferred_username?: string;
}

export interface SessionUser {
  oid: string;
  name: string;
  email: string;
  /** Tenant d'origine de l'utilisateur (tenant partenaire pour un invité B2B). */
  homeTenantId: string;
  isGuest: boolean;
}

export interface AuthzOptions {
  tenantId: string;
  partnerTenantId: string;
  allowInternalUsers: boolean;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Décide si l'utilisateur authentifié peut utiliser le portail. Le jeton est émis par NOTRE tenant ;
 * pour un invité B2B, la claim `idp` porte l'émetteur de son tenant d'origine.
 */
export function authorizeUser(claims: IdTokenClaims, opts: AuthzOptions): { ok: true; user: SessionUser } | { ok: false; reason: string } {
  if (!claims.oid || !GUID.test(claims.oid)) return { ok: false, reason: 'missing_oid' };
  if (claims.tid?.toLowerCase() !== opts.tenantId.toLowerCase()) return { ok: false, reason: 'wrong_tenant' };
  if (!claims.roles?.includes(REQUIRED_ROLE)) return { ok: false, reason: 'missing_role' };

  const idpTenant = claims.idp ? GUID.exec(claims.idp)?.[0]?.toLowerCase() : undefined;
  const isGuest = idpTenant !== undefined && idpTenant !== opts.tenantId.toLowerCase();

  if (isGuest) {
    if (idpTenant !== opts.partnerTenantId.toLowerCase()) return { ok: false, reason: 'unknown_home_tenant' };
  } else {
    if (claims.idp && !idpTenant) return { ok: false, reason: 'unsupported_idp' };
    if (!opts.allowInternalUsers) return { ok: false, reason: 'internal_user_not_allowed' };
  }

  const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase();
  if (!isEmail(email) || email.includes('#ext#')) return { ok: false, reason: 'missing_email' };

  return {
    ok: true,
    user: {
      oid: claims.oid.toLowerCase(),
      name: (claims.name ?? email).slice(0, 120),
      email,
      homeTenantId: isGuest ? idpTenant! : opts.tenantId.toLowerCase(),
      isGuest,
    },
  };
}
