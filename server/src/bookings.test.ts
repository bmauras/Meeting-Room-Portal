import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitationBody, type MeetingDetails } from './bookings.js';

const details: MeetingDetails = {
  roomName: 'Boavista',
  when: 'mardi 1 décembre 2026, 14:15 – 15:15',
  subject: 'Test 3',
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
};

test('invitation : texte, date, salle, objet et lien Teams, sans lien du portail', () => {
  const html = invitationBody(details);
  assert.match(html, /<p>Bonjour,<\/p><p>Vous avez été invité\(e\) à participer à une réunion\.<\/p>/);
  assert.match(html, /Quand :<\/b> mardi 1 décembre 2026, 14:15 – 15:15/);
  assert.match(html, /Salle :<\/b> Boavista/);
  assert.match(html, /Objet :<\/b> Test 3/);
  assert.match(html, /Rejoindre la réunion/);
  assert.doesNotMatch(html, /portail/i);
});

test('invitation sans réunion Teams : pas de bloc Teams', () => {
  assert.doesNotMatch(invitationBody({ ...details, joinUrl: null }), /Teams/);
});

test('invitation : objet saisi échappé', () => {
  const html = invitationBody({ ...details, subject: 'A & B <i>' });
  assert.match(html, /A &amp; B &lt;i&gt;/);
});
