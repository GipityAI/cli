/**
 * `gipity mcp` - the app's hosted MCP server status. Mocked API: prints the
 * URL, profile, tools and the connect commands when on; the reason and the
 * fix when off; the same data with --json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { connectorName } from '../commands/mcp.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

const ON = {
  on: true, url: 'https://a.gipity.ai/api/p_TestProj/mcp', api_url: 'https://a.gipity.ai/api/p_TestProj/mcp', custom_domain: null, off_reason: null, name: 'ECU Tuner', profile: 'agent', instructions: null,
  tools: [
    { name: 'list_logs', description: 'Recent logs', read_only: true },
    { name: 'submit_plan', description: null, read_only: false },
  ],
};

test('gipity mcp shows the URL, profile, tools and how to connect', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/mcp', { body: { data: ON } });
  const r = await fresh(['mcp']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP server: on/);
  assert.match(r.stdout, /https:\/\/a\.gipity\.ai\/api\/p_TestProj\/mcp/);
  assert.match(r.stdout, /agent \(2 tools\)/);
  assert.match(r.stdout, /list_logs \(read only\)\s+Recent logs/);
  assert.match(r.stdout, /claude mcp add --transport http ecu-tuner https:\/\/a\.gipity\.ai\/api\/p_TestProj\/mcp/);
  assert.match(r.stdout, /ChatGPT/);
  assert.doesNotMatch(r.stdout, /undefined|null/);
});

test('gipity mcp shows the custom domain URL first and the API host URL as secondary', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/mcp', { body: { data: { ...ON, url: 'https://mcp.tunerloop.example', custom_domain: 'mcp.tunerloop.example' } } });
  const r = await fresh(['mcp']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /URL\s+https:\/\/mcp\.tunerloop\.example/);
  assert.match(r.stdout, /Also\s+https:\/\/a\.gipity\.ai\/api\/p_TestProj\/mcp/);
  assert.match(r.stdout, /claude mcp add --transport http ecu-tuner https:\/\/mcp\.tunerloop\.example/);
});

test('gipity mcp --json returns the status plus the connect commands', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/mcp', { body: { data: ON } });
  const r = await fresh(['mcp', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.on, true);
  assert.equal(out.tools.length, 2);
  assert.equal(out.connect.claude_code, 'claude mcp add --transport http ecu-tuner https://a.gipity.ai/api/p_TestProj/mcp');
});

test('gipity mcp says why it is off and how to turn it on', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/mcp', { body: { data: {
    on: false, url: 'https://a.gipity.ai/api/p_TestProj/mcp', off_reason: 'no mcp: block in gipity.yaml', name: null, profile: null, instructions: null, tools: [],
  } } });
  const r = await fresh(['mcp']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP server: off \(no mcp: block in gipity\.yaml\)/);
  assert.match(r.stdout, /mcp: \{ profile:/);
});

test('connector names are short lowercase slugs', () => {
  assert.equal(connectorName('ECU Tuner!'), 'ecu-tuner');
  assert.equal(connectorName(null), 'app');
  assert.equal(connectorName('***'), 'app');
});
