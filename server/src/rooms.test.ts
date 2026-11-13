import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphError, type GraphClient } from './graph.js';
import { RoomService, roomExclusion } from './rooms.js';

const room = 'room1@contoso.com';

/** Faux Graph : le calendrier de la salle n'a pas encore traité les changements faits via le portail. */
function fakeGraph(items: { start: string; end: string }[]): GraphClient {
  return {
    request: async () => ({
      value: [
        {
          scheduleId: room,
          scheduleItems: items.map((i) => ({
            status: 'busy',
            start: { dateTime: `${i.start}:00.0000000`, timeZone: 'Europe/Paris' },
            end: { dateTime: `${i.end}:00.0000000`, timeZone: 'Europe/Paris' },
          })),
        },
      ],
    }),
    getAll: async () => [],
  } as unknown as GraphClient;
}

test('une réservation récente apparaît avant son traitement par la salle', async () => {
  const rooms = new RoomService(fakeGraph([]), 'org@contoso.com', 'Europe/Paris');
  rooms.recordBooking(room, '2026-11-05T09:00', '2026-11-05T10:00');
  const busy = (await rooms.getBusySlots([room], '2026-11-05T08:00', '2026-11-05T19:00')).get(room);
  assert.deepEqual(busy, [{ start: '2026-11-05T09:00', end: '2026-11-05T10:00' }]);
  // Hors de la plage demandée : ignorée.
  const other = (await rooms.getBusySlots([room], '2026-11-06T08:00', '2026-11-06T19:00')).get(room);
  assert.deepEqual(other, []);
});

test('demandes simultanées sur le même créneau : une seule obtient la salle', () => {
  const rooms = new RoomService(fakeGraph([]), 'org@contoso.com', 'Europe/Paris');
  assert.equal(rooms.tryHold(room, '2026-11-05T09:00', '2026-11-05T10:00'), true);
  assert.equal(rooms.tryHold(room, '2026-11-05T09:30', '2026-11-05T10:30'), false, 'chevauchement');
  assert.equal(rooms.tryHold(room, '2026-11-05T10:00', '2026-11-05T11:00'), true, 'créneau contigu');
  assert.equal(rooms.tryHold('autre@contoso.com', '2026-11-05T09:00', '2026-11-05T10:00'), true, 'autre salle');
  // Échec de la première réservation : le créneau est libéré.
  rooms.releaseHold(room, '2026-11-05T09:00', '2026-11-05T10:00');
  assert.equal(rooms.tryHold(room, '2026-11-05T09:00', '2026-11-05T09:30'), true);
});

test('pas de doublon une fois la réservation traitée par la salle', async () => {
  const rooms = new RoomService(fakeGraph([{ start: '2026-11-05T09:00', end: '2026-11-05T10:00' }]), 'org@contoso.com', 'Europe/Paris');
  rooms.recordBooking(room, '2026-11-05T09:00', '2026-11-05T10:00');
  const busy = (await rooms.getBusySlots([room], '2026-11-05T08:00', '2026-11-05T19:00')).get(room);
  assert.equal(busy?.length, 1);
});

function placesGraph(places: { emailAddress: string; displayName: string; building?: string }[], fail = false): GraphClient {
  return {
    request: async () => ({ value: [] }),
    getAll: async (path: string) => {
      if (fail) throw new Error('Places indisponible');
      return path.startsWith('/places/microsoft.graph.room?') ? places : [];
    },
  } as unknown as GraphClient;
}

test('annuaire synchronisé : il fait foi, Places enrichit', async () => {
  const graph = placesGraph([
    { emailAddress: 'a@contoso.com', displayName: 'A (Places)', building: 'Siège' },
    { emailAddress: 'supprimee@contoso.com', displayName: 'Supprimée dans Exchange' },
  ]);
  const rooms = new RoomService(graph, 'org@contoso.com', 'Europe/Paris');
  rooms.setDirectory(
    [
      { email: 'a@contoso.com', name: 'Salle A', capacity: 6 },
      { email: 'nouvelle@contoso.com', name: 'Nouvelle salle', capacity: 4 },
    ],
    Date.now(),
  );
  const list = await rooms.listRooms();
  assert.deepEqual(
    list.map((r) => [r.email, r.name, r.building]),
    [
      ['nouvelle@contoso.com', 'Nouvelle salle', null],
      ['a@contoso.com', 'Salle A', 'Siège'],
    ],
  );
});

test('salle modifiée dans Exchange : les valeurs récentes priment sur Places, en retard', async () => {
  const graph = placesGraph([
    { emailAddress: 'a@contoso.com', displayName: 'Ancien nom', building: 'Siège', capacity: 4, floorLabel: '1', videoDeviceName: 'Surface Hub' } as never,
  ]);
  const rooms = new RoomService(graph, 'org@contoso.com', 'Europe/Paris');
  // Renommée, capacité passée à 10, déménagée au 3e étage ; équipements non transmis (Get-Place indisponible).
  rooms.setDirectory([{ email: 'a@contoso.com', name: 'Nouveau nom', capacity: 10, floor: '3' }], Date.now());
  const [room] = await rooms.listRooms();
  assert.deepEqual(
    { name: room?.name, capacity: room?.capacity, floor: room?.floor, building: room?.building, hasVideo: room?.hasVideo },
    { name: 'Nouveau nom', capacity: 10, floor: '3', building: 'Siège', hasVideo: true },
  );

  // Synchronisation suivante : visio retirée dans Exchange.
  rooms.setDirectory([{ email: 'a@contoso.com', name: 'Nouveau nom', capacity: 10, floor: '3', hasVideo: false }], Date.now());
  assert.equal((await rooms.listRooms())[0]?.hasVideo, false);
});

test('annuaire ancien : Places, complété par l’annuaire', async () => {
  const rooms = new RoomService(placesGraph([{ emailAddress: 'a@contoso.com', displayName: 'A' }]), 'org@contoso.com', 'Europe/Paris');
  rooms.setDirectory([{ email: 'b@contoso.com', name: 'B' }], Date.now() - 3 * 60 * 60 * 1000);
  assert.deepEqual((await rooms.listRooms()).map((r) => r.email), ['a@contoso.com', 'b@contoso.com']);
});

test('Places indisponible : l’annuaire suffit', async () => {
  const rooms = new RoomService(placesGraph([], true), 'org@contoso.com', 'Europe/Paris');
  rooms.setDirectory([{ email: 'a@contoso.com', name: 'A' }], Date.now());
  assert.deepEqual((await rooms.listRooms()).map((r) => r.email), ['a@contoso.com']);
});

test('une annulation récente libère le créneau avant son traitement par la salle', async () => {
  const graph = fakeGraph([
    { start: '2026-11-05T09:00', end: '2026-11-05T10:00' },
    { start: '2026-11-05T14:00', end: '2026-11-05T15:00' },
  ]);
  const rooms = new RoomService(graph, 'org@contoso.com', 'Europe/Paris');
  rooms.recordCancellation(room, '2026-11-05T09:00', '2026-11-05T10:00');
  const busy = (await rooms.getBusySlots([room], '2026-11-05T08:00', '2026-11-05T19:00')).get(room);
  assert.deepEqual(busy, [{ start: '2026-11-05T14:00', end: '2026-11-05T15:00' }]);
});

test('salles exclues : adresses exactes et motifs, ni listées ni réservables', async () => {
  const graph = placesGraph([
    { emailAddress: 'A@contoso.com', displayName: 'A' },
    { emailAddress: 'direction@contoso.com', displayName: 'Direction' },
    { emailAddress: 'salle1-labo@contoso.com', displayName: 'Labo 1' },
    { emailAddress: 'b@site-b.contoso.com', displayName: 'Site B' },
  ]);
  const rooms = new RoomService(graph, 'org@contoso.com', 'Europe/Paris', [], ['Direction@contoso.com', '*-labo@contoso.com', '*@site-b.contoso.com']);
  assert.deepEqual((await rooms.listRooms()).map((r) => r.email), ['a@contoso.com']);
  assert.equal(await rooms.getRoom('direction@contoso.com'), undefined);
});

test('exclusion : le point d’un motif n’est pas un joker', () => {
  const excluded = roomExclusion(['*@site.contoso.com']);
  assert.equal(excluded('x@site.contoso.com'), true);
  assert.equal(excluded('x@siteXcontoso.com'), false);
});

/** Faux Graph : getSchedule échoue pour les lots qui contiennent une salle « lente ». */
function scheduleGraph(slow: Set<string>): GraphClient {
  return {
    request: async (_m: string, _p: string, opts: { body: { schedules: string[] } }) => {
      if (opts.body.schedules.some((s) => slow.has(s))) throw new GraphError(504, 'timeout', 'no response');
      return { value: opts.body.schedules.map((s) => ({ scheduleId: s, scheduleItems: [] })) };
    },
    getAll: async () => [],
  } as unknown as GraphClient;
}

test('un lot getSchedule en échec : ses salles en disponibilité inconnue, les autres affichées', async () => {
  const emails = Array.from({ length: 25 }, (_, i) => `r${i}@contoso.com`);
  const rooms = new RoomService(scheduleGraph(new Set(['r3@contoso.com'])), 'org@contoso.com', 'Europe/Paris');
  const busy = await rooms.getBusySlots(emails, '2026-11-05T08:00', '2026-11-05T19:00');
  assert.equal(busy.get('r3@contoso.com'), null);
  assert.equal(busy.get('r0@contoso.com'), null, 'même lot que la salle lente');
  assert.deepEqual(busy.get('r10@contoso.com'), []);
  assert.deepEqual(busy.get('r24@contoso.com'), []);
});

test('tous les lots getSchedule en échec : erreur Graph remontée', async () => {
  const rooms = new RoomService(scheduleGraph(new Set(['r0@contoso.com'])), 'org@contoso.com', 'Europe/Paris');
  await assert.rejects(rooms.getBusySlots(['r0@contoso.com'], '2026-11-05T08:00', '2026-11-05T19:00'), GraphError);
});
