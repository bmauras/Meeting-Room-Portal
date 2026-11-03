import { Router } from 'express';
import { ConfidentialClientApplication, CryptoProvider, ResponseMode } from '@azure/msal-node';
import { ManagedIdentityCredential } from '@azure/identity';
import type { AuditLog } from '../audit.js';
import { authorizeUser, type IdTokenClaims } from '../authz.js';
import type { Config } from '../config.js';
import { requireSameOrigin, wrap } from '../http.js';
import type { Sessions } from '../session.js';

const SCOPES = ['openid', 'profile', 'email'];

/**
 * En Azure, l'app registration n'a aucun secret : la Managed Identity de l'App Service est
 * déclarée comme credential fédéré et fournit l'assertion client.
 */
export function createMsalClient(config: Config): ConfidentialClientApplication {
  const authority = `https://login.microsoftonline.com/${config.TENANT_ID}`;
  if (config.ENTRA_CLIENT_SECRET) {
    return new ConfidentialClientApplication({ auth: { clientId: config.ENTRA_CLIENT_ID, authority, clientSecret: config.ENTRA_CLIENT_SECRET } });
  }
  if (!config.AZURE_CLIENT_ID) throw new Error('AZURE_CLIENT_ID ou ENTRA_CLIENT_SECRET requis');
  const identity = new ManagedIdentityCredential({ clientId: config.AZURE_CLIENT_ID });
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.ENTRA_CLIENT_ID,
      authority,
      clientAssertion: async () => (await identity.getToken('api://AzureADTokenExchange/.default')).token,
    },
  });
}

export function authRouter(deps: { config: Config; msal: ConfidentialClientApplication; sessions: Sessions; audit: AuditLog }): Router {
  const { config, msal, sessions, audit } = deps;
  const router = Router();
  const crypto = new CryptoProvider();
  const redirectUri = `${config.PUBLIC_BASE_URL}/auth/callback`;

  router.get(
    '/login',
    wrap(async (req, res) => {
      const { verifier, challenge } = await crypto.generatePkceCodes();
      const tx = await sessions.transaction(req, res);
      tx.state = crypto.createNewGuid();
      tx.nonce = crypto.createNewGuid();
      tx.verifier = verifier;
      await tx.save();

      const url = await msal.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri,
        responseMode: ResponseMode.QUERY,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state: tx.state,
        nonce: tx.nonce,
        prompt: 'select_account',
      });
      res.redirect(url);
    }),
  );

  router.get(
    '/callback',
    wrap(async (req, res) => {
      const tx = await sessions.transaction(req, res);
      const { state, nonce, verifier } = tx;
      tx.destroy();

      const { code, error } = req.query;
      if (typeof error === 'string') {
        await audit.write({ action: 'login', outcome: 'failure', ip: req.ip, details: { error: error.slice(0, 64) } });
        return res.redirect('/?error=signin');
      }
      if (typeof code !== 'string' || !state || req.query.state !== state || !verifier) {
        return res.redirect('/?error=signin');
      }

      const result = await msal.acquireTokenByCode({ code, scopes: SCOPES, redirectUri, codeVerifier: verifier });
      // Aucun jeton n'est réutilisé : on vide le cache MSAL pour ne rien garder en mémoire.
      if (result.account) await msal.getTokenCache().removeAccount(result.account);

      const claims = result.idTokenClaims as IdTokenClaims & { nonce?: string };
      if (!nonce || claims.nonce !== nonce) return res.redirect('/?error=signin');

      const decision = authorizeUser(claims, {
        tenantId: config.TENANT_ID,
        partnerTenantId: config.PARTNER_TENANT_ID,
        allowInternalUsers: config.ALLOW_INTERNAL_USERS,
      });
      if (!decision.ok) {
        await audit.write({ action: 'login', outcome: 'denied', userOid: claims.oid, ip: req.ip, details: { reason: decision.reason } });
        return res.redirect('/?error=forbidden');
      }

      const session = await sessions.user(req, res);
      session.user = decision.user;
      await session.save();
      await audit.write({
        action: 'login',
        outcome: 'success',
        userOid: decision.user.oid,
        userEmail: decision.user.email,
        homeTenantId: decision.user.homeTenantId,
        ip: req.ip,
      });
      res.redirect('/');
    }),
  );

  router.post(
    '/logout',
    requireSameOrigin(config.PUBLIC_BASE_URL),
    wrap(async (req, res) => {
      const session = await sessions.user(req, res);
      session.destroy();
      const params = new URLSearchParams({ post_logout_redirect_uri: `${config.PUBLIC_BASE_URL}/` });
      res.json({ logoutUrl: `https://login.microsoftonline.com/${config.TENANT_ID}/oauth2/v2.0/logout?${params}` });
    }),
  );

  return router;
}
