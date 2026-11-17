import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationMail, invitationBody, type MeetingDetails } from './bookings.js';

const details: MeetingDetails = {
  bookerName: 'Bruno MAURAS',
  roomName: 'Boavista',
  when: 'mardi 1 décembre 2026, 14:15 – 15:15',
  subject: 'Test 3',
  attendees: ['a@contoso.com', 'b@contoso.com'],
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
};
const portal = 'https://reservation.contoso.com';

test('invitation : informations de la réunion et lien Teams, jamais le lien du portail', () => {
  const html = invitationBody(details);
  assert.match(html, /<b>Bruno MAURAS<\/b> vous invite à une réunion/);
  assert.match(html, /Quand :<\/b> mardi 1 décembre 2026, 14:15 – 15:15/);
  assert.match(html, /Où :<\/b> Boavista/);
  assert.match(html, /Rejoindre la réunion/);
  assert.doesNotMatch(html, /portail|reservation\.contoso\.com/i);
});

test('invitation sans réunion Teams : pas de bloc Teams', () => {
  assert.doesNotMatch(invitationBody({ ...details, joinUrl: null }), /Teams/);
});

test('confirmation : lien du portail, participants et lien Teams', () => {
  const { subject, html } = confirmationMail(details, portal);
  assert.equal(subject, 'Réservation enregistrée : Boavista – mardi 1 décembre 2026, 14:15 – 15:15');
  assert.match(html, /href="https:\/\/reservation\.contoso\.com">Ouvrir le portail/);
  assert.match(html, /a@contoso\.com, b@contoso\.com/);
  assert.match(html, /Rejoindre la réunion Teams/);
  assert.match(confirmationMail({ ...details, attendees: [] }, portal).html, /aucun autre participant/);
});

test('contenu saisi échappé (nom, objet)', () => {
  const html = confirmationMail({ ...details, bookerName: '<script>x</script>', subject: 'A & B' }, portal).html;
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /A &amp; B/);
});
