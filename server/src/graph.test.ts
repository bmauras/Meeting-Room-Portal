import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TokenCredential } from '@azure/identity';
import { GraphClient, GraphError } from './graph.js';

const credential: TokenCredential = { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3600_000 }) };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** fetch simulé : chaque appel consomme la réponse suivante (une erreur est levée). */
function mockFetch(responses: (Response | Error)[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const next = responses[state.calls++];
    if (next instanceof Error) throw next;
    return next!;
  }) as typeof fetch;
  return state;
}

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('délai dépassé sur une lecture : relancée une fois', async () => {
  const state = mockFetch([timeout(), new Response(JSON.stringify({ value: [1] }), { status: 200 })]);
  const res = await new GraphClient(credential, 'Europe/Paris').request<{ value: number[] }>('GET', '/places');
  assert.deepEqual(res.value, [1]);
  assert.equal(state.calls, 2);
});

test('délai dépassé deux fois : GraphError 504 (et non une erreur interne)', async () => {
  mockFetch([timeout(), timeout()]);
  await assert.rejects(new GraphClient(credential, 'Europe/Paris').request('GET', '/places'), (err) => err instanceof GraphError && err.status === 504);
});

test('délai dépassé sur une création : jamais relancée', async () => {
  const state = mockFetch([timeout(), new Response('{}', { status: 201 })]);
  await assert.rejects(new GraphClient(credential, 'Europe/Paris').request('POST', '/users/x/events', { body: {} }), GraphError);
  assert.equal(state.calls, 1);
});

test('erreur réseau : GraphError 503', async () => {
  mockFetch([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })]);
  await assert.rejects(
    new GraphClient(credential, 'Europe/Paris').request('POST', '/users/x/calendar/getSchedule', { body: {} }),
    (err) => err instanceof GraphError && err.status === 503 && err.message.includes('ECONNRESET'),
  );
});

test('identité managée indisponible : GraphError', async () => {
  const failing: TokenCredential = { getToken: async () => Promise.reject(new Error('IMDS unreachable')) };
  await assert.rejects(new GraphClient(failing, 'Europe/Paris').request('GET', '/places'), (err) => err instanceof GraphError && err.code === 'token_unavailable');
});
