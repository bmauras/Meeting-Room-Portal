import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAttendees, sanitizeSubject, validateSlot, type BookingRules } from './rules.js';
import { addDays, nowLocal } from './time.js';

const rules: BookingRules = {
  timeZone: 'Europe/Paris',
  dayStart: '08:00',
  dayEnd: '19:00',
  slotMinutes: 15,
  maxDurationMinutes: 240,
  horizonDays: 30,
  allowWeekends: false,
  allowedAttendeeDomains: ['contoso.com', 'partner.com'],
};
// Lundi 2 novembre 2026, 10:00
const now = '2026-11-02T10:00';

test('créneau valide', () => {
  assert.equal(validateSlot('2026-11-03T09:00', '2026-11-03T10:30', rules, now), null);
});

test('créneaux refusés', () => {
  assert.match(validateSlot('2026-11-02T09:00', '2026-11-02T09:30', rules, now)!, /futur/);
  assert.match(validateSlot('2026-11-03T09:10', '2026-11-03T10:00', rules, now)!, /multiples/);
  assert.match(validateSlot('2026-11-03T10:00', '2026-11-03T09:00', rules, now)!, /après/);
  assert.match(validateSlot('2026-11-03T08:00', '2026-11-03T13:00', rules, now)!, /maximale/);
  assert.match(validateSlot('2026-11-03T07:00', '2026-11-03T08:00', rules, now)!, /réservables/);
  assert.match(validateSlot('2026-11-07T09:00', '2026-11-07T10:00', rules, now)!, /week-end/);
  assert.match(validateSlot('2026-12-15T09:00', '2026-12-15T10:00', rules, now)!, /jours/);
  assert.match(validateSlot('2026-11-03T09:00', '2026-11-04T10:00', rules, now)!, /même jour/);
  assert.match(validateSlot('2026-02-30T09:00', '2026-02-30T10:00', rules, now)!, /invalide/);
  assert.match(validateSlot('2026-11-03 09:00', '2026-11-03T10:00', rules, now)!, /Format/);
});

test('objet : nettoyage et rejet des liens', () => {
  assert.deepEqual(sanitizeSubject('  Revue   projet​ Q4 '), { ok: true, value: 'Revue projet Q4' });
  assert.equal(sanitizeSubject('Voir https://evil.example').ok, false);
  assert.equal(sanitizeSubject('www.evil.com').ok, false);
  assert.equal(sanitizeSubject('evil.com/login').ok, false);
  assert.equal(sanitizeSubject('<b>hi</b>').ok, false);
  assert.equal(sanitizeSubject('ab').ok, false);
  assert.equal(sanitizeSubject('x'.repeat(81)).ok, false);
});

test('participants : domaines autorisés uniquement', () => {
  assert.deepEqual(normalizeAttendees(['A@Contoso.com', 'a@contoso.com', ' ', 'me@partner.com'], rules, 'me@partner.com'), {
    ok: true,
    value: ['a@contoso.com'],
  });
  assert.equal(normalizeAttendees(['x@gmail.com'], rules, 'me@partner.com').ok, false);
  assert.equal(normalizeAttendees(['not-an-email'], rules, 'me@partner.com').ok, false);
});

test('helpers de date', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(nowLocal('Europe/Paris', new Date('2026-07-01T08:30:00Z')), '2026-07-01T10:30');
  assert.equal(nowLocal('Europe/Paris', new Date('2026-12-01T08:30:00Z')), '2026-12-01T09:30');
});
