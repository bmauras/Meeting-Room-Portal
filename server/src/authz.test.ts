import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUser, type IdTokenClaims } from './authz.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const partnerTenantId = '22222222-2222-2222-2222-222222222222';
const opts = { tenantId, partnerTenantId, allowInternalUsers: false };

const guest: IdTokenClaims = {
  oid: '33333333-3333-3333-3333-333333333333',
  tid: tenantId,
  idp: `https://sts.windows.net/${partnerTenantId}/`,
  roles: ['Room.Booker'],
  name: 'Jane Partner',
  email: 'Jane@Partner.com',
};

test('invité du tenant partenaire avec le rôle : autorisé', () => {
  const r = authorizeUser(guest, opts);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.user.email, 'jane@partner.com');
    assert.equal(r.user.homeTenantId, partnerTenantId);
    assert.equal(r.user.isGuest, true);
  }
});

test('refus : rôle manquant, autre tenant d’origine, mauvais émetteur', () => {
  assert.deepEqual(authorizeUser({ ...guest, roles: [] }, opts), { ok: false, reason: 'missing_role' });
  assert.deepEqual(
    authorizeUser({ ...guest, idp: 'https://sts.windows.net/44444444-4444-4444-4444-444444444444/' }, opts),
    { ok: false, reason: 'unknown_home_tenant' },
  );
  assert.deepEqual(authorizeUser({ ...guest, idp: 'live.com' }, opts), { ok: false, reason: 'unsupported_idp' });
  assert.deepEqual(authorizeUser({ ...guest, tid: partnerTenantId }, opts), { ok: false, reason: 'wrong_tenant' });
  assert.deepEqual(authorizeUser({ ...guest, email: undefined, preferred_username: 'jane_partner.com#EXT#@contoso.onmicrosoft.com' }, opts), {
    ok: false,
    reason: 'missing_email',
  });
});

test('utilisateur interne : refusé sauf si explicitement autorisé', () => {
  const internal = { ...guest, idp: undefined, email: 'bob@contoso.com' };
  assert.deepEqual(authorizeUser(internal, opts), { ok: false, reason: 'internal_user_not_allowed' });
  assert.equal(authorizeUser(internal, { ...opts, allowInternalUsers: true }).ok, true);
});
