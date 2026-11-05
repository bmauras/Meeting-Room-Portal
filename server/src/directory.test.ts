import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createSyncAuthenticator, SYNC_ROLE } from './directory.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const clientId = '22222222-2222-2222-2222-222222222222';
const syncPrincipalId = '33333333-3333-3333-3333-333333333333';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
const authenticate = createSyncAuthenticator({ tenantId, clientId, syncPrincipalId, keys: createLocalJWKSet({ keys: [jwk] }) });

async function token(overrides: Record<string, unknown> = {}, opts: { issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT({ tid: tenantId, oid: syncPrincipalId, roles: [SYNC_ROLE], ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(opts.issuer ?? `https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(opts.audience ?? clientId)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(privateKey);
}

test('jeton du runbook : accepté (émetteurs v1 et v2, audience GUID ou api://)', async () => {
  assert.equal(await authenticate(`Bearer ${await token()}`), true);
  assert.equal(await authenticate(`Bearer ${await token({}, { issuer: `https://sts.windows.net/${tenantId}/`, audience: `api://${clientId}` })}`), true);
});

test('jetons refusés', async () => {
  assert.equal(await authenticate(undefined), false);
  assert.equal(await authenticate('Basic abc'), false);
  assert.equal(await authenticate(`Bearer ${await token({ oid: '44444444-4444-4444-4444-444444444444' })}`), false, 'autre identité');
  assert.equal(await authenticate(`Bearer ${await token({ roles: ['Room.Booker'] })}`), false, 'rôle manquant');
  assert.equal(await authenticate(`Bearer ${await token({}, { audience: 'api://autre-application' })}`), false, 'autre audience');
  assert.equal(await authenticate(`Bearer ${await token({}, { issuer: 'https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/v2.0' })}`), false, 'autre tenant');
  assert.equal(await authenticate(`Bearer ${await token({}, { expiresIn: '-10m' })}`), false, 'expiré');

  const { privateKey: otherKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({ tid: tenantId, oid: syncPrincipalId, roles: [SYNC_ROLE] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(clientId)
    .setExpirationTime('5m')
    .sign(otherKey);
  assert.equal(await authenticate(`Bearer ${forged}`), false, 'signature invalide');
});
