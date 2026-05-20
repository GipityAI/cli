import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const SF = {
  source: 'ip', city: 'San Francisco', region: 'CA', country: 'US',
  timezone: 'America/Los_Angeles', lat: 37.78, lon: -122.41, ip: '1.2.3.4', accuracy: 100,
};

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

test('gipity location (no args) hits /location/me', async () => {
  mock.reset();
  mock.on('GET /location/me', { body: { data: SF } });
  const r = await run(['location']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /San Francisco/);
  assert.match(r.stdout, /Source:\s+ip/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity location <ip> POSTs IP lookup', async () => {
  mock.reset();
  mock.on('POST /location/ip', { body: { data: SF } });
  const r = await run(['location', '8.8.8.8']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /San Francisco/);
});

test('gipity location <lat> <lng> POSTs reverse geocode', async () => {
  mock.reset();
  mock.on('POST /location/coords', { body: { data: SF } });
  const r = await run(['location', '--', '37.78', '-122.41']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /San Francisco/);
});

test('gipity location latest hits /location/latest', async () => {
  mock.reset();
  mock.on('GET /location/latest', { body: { data: { ...SF, source: 'latest' } } });
  const r = await run(['location', 'latest']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Source:\s+latest/);
});

test('gipity location history --count lists rows', async () => {
  mock.reset();
  mock.on('GET /location/history', { body: { data: [
    { ...SF, source: 'history' },
    { ...SF, source: 'history', city: 'Portland' },
  ] } });
  const r = await run(['location', 'history', '--count', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /San Francisco/);
  assert.match(r.stdout, /Portland/);
});
