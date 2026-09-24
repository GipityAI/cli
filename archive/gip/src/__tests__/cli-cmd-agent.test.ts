import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const AGENT_A = { short_guid: 'a_AgentA0n0', name: 'Alice', is_default: 1, model_preference: 'claude-sonnet-4-6', temperature: 0.7, voice_id: null, voice_provider: null, created_at: '2026-01-01T00:00:00Z' };
const AGENT_B = { short_guid: 'a_AgentB0n0', name: 'Bob',   is_default: 0, model_preference: null, temperature: null, voice_id: null, voice_provider: null, created_at: '2026-02-01T00:00:00Z' };

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => { await mock.stop(); });

/** Each test gets a fresh project dir so config writes (e.g. agent switch) don't bleed. */
function inProject(args: string[], agentGuid = AGENT_A.short_guid) {
  const projectDir = makeProjectDir({ apiBase: mock.apiBase, agentGuid });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: projectDir });
}

test('gipity agent (bare) lists agents and stars the active one', async () => {
  mock.reset();
  mock.on('GET /agents', { body: { data: [AGENT_A, AGENT_B] } });
  const r = await inProject(['agent']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Alice/);
  assert.match(r.stdout, /Bob/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity agent <name> switches to that agent', async () => {
  mock.reset();
  mock.on('GET /agents', { body: { data: [AGENT_A, AGENT_B] } });
  const r = await inProject(['agent', 'Bob']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Switched to Bob/);
});

test('gipity agent create <name> POSTs and prints created message', async () => {
  mock.reset();
  mock.on('POST /agents', { status: 201, body: { data: { ...AGENT_B, name: 'Carol', short_guid: 'a_NewCarol00' } } });
  const r = await inProject(['agent', 'create', 'Carol']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Created "Carol"/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity agent set model sends PUT with the value', async () => {
  mock.reset();
  mock.on('PUT /agents/a_AgentA0n0', { body: { data: AGENT_A } });
  const r = await inProject(['agent', 'set', 'model', 'claude-opus-4-7']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Set model = claude-opus-4-7/);
});

test('gipity agent rename sends PUT and prints renamed line', async () => {
  mock.reset();
  mock.on('PUT /agents/a_AgentA0n0', { body: { data: AGENT_A } });
  const r = await inProject(['agent', 'rename', 'Alicia']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed.*Alicia/);
});

test('gipity agent info shows name + model + created date', async () => {
  mock.reset();
  mock.on('GET /agents/a_AgentA0n0', { body: { data: AGENT_A } });
  const r = await inProject(['agent', 'info']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Name:\s+Alice/);
  assert.match(r.stdout, /Model:\s+claude-sonnet-4-6/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity agent delete --yes calls DELETE and prints deleted line', async () => {
  mock.reset();
  mock.on('GET /agents', { body: { data: [AGENT_A, AGENT_B] } });
  mock.on('DELETE /agents/a_AgentB0n0', { body: { data: { deleted: true } } });
  // delete prompts for confirmation; pass --yes via the global flag
  const r = await inProject(['--yes', 'agent', 'delete', 'Bob']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deleted "Bob"/);
});

// --- Brain: soul / goal / rules / learn (the /account/agents surface) ---

test('gipity agent soul (no text) GETs and prints the soul', async () => {
  mock.reset();
  mock.on('GET /account/agents/a_AgentA0n0/soul', { body: { data: { content: 'Warm and candid.' } } });
  const r = await inProject(['agent', 'soul']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Warm and candid/);
});

test('gipity agent soul <text> PUTs the new soul', async () => {
  mock.reset();
  mock.on('PUT /account/agents/a_AgentA0n0/soul', { body: { data: { content: 'Be brief.' } } });
  const r = await inProject(['agent', 'soul', 'Be', 'brief.']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Soul updated/);
  const put = mock.requests().find(x => x.method === 'PUT');
  assert.deepEqual(put?.body, { content: 'Be brief.' });
});

test('gipity agent goal <text> PUTs, --clear nulls it', async () => {
  mock.reset();
  mock.on('PUT /account/agents/a_AgentA0n0/goal', { body: { data: { goal: 'Win.' } } });
  const r = await inProject(['agent', 'goal', 'Win.']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Goal updated/);

  mock.reset();
  mock.on('PUT /account/agents/a_AgentA0n0/goal', { body: { data: { goal: null } } });
  const c = await inProject(['agent', 'goal', '--clear']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Goal cleared/);
  const put = mock.requests().find(x => x.method === 'PUT');
  assert.deepEqual(put?.body, { goal: null });
});

test('gipity agent rules lists with source + guid', async () => {
  mock.reset();
  mock.on('GET /account/agents/a_AgentA0n0/rules', { body: { data: [
    { short_guid: 'rule_aaa', text: 'No em dashes.', source: 'manual', active: true },
    { short_guid: 'rule_bbb', text: 'Lead with a fact.', source: 'learned', active: true },
  ] } });
  const r = await inProject(['agent', 'rules']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /manual.*rule_aaa.*No em dashes/);
  assert.match(r.stdout, /learned.*rule_bbb/);
});

test('gipity agent rules add POSTs the rule text', async () => {
  mock.reset();
  mock.on('POST /account/agents/a_AgentA0n0/rules', { status: 201, body: { data: [{ short_guid: 'rule_new', text: 'One CTA.', source: 'manual', active: true }] } });
  const r = await inProject(['agent', 'rules', 'add', 'One', 'CTA.']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Added rule rule_new/);
  const post = mock.requests().find(x => x.method === 'POST');
  assert.deepEqual(post?.body, { text: 'One CTA.' });
});

test('gipity agent rules rm DELETEs by guid', async () => {
  mock.reset();
  mock.on('DELETE /account/agents/a_AgentA0n0/rules/rule_bbb', { body: { data: { short_guid: 'rule_bbb', active: false } } });
  const r = await inProject(['agent', 'rules', 'rm', 'rule_bbb']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed rule rule_bbb/);
});

test('gipity agent learn POSTs the correction and reports the saved rule', async () => {
  mock.reset();
  mock.on('POST /account/agents/a_AgentA0n0/learn', { body: { data: { saved: true, rule: { short_guid: 'rule_l', text: 'Lead with a specific observation.', source: 'learned', active: true }, reason: 'too salesy' } } });
  const r = await inProject(['agent', 'learn', '--original', 'Buy now!', '--comment', 'Too salesy.']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Learned: Lead with a specific observation/);
  const post = mock.requests().find(x => x.method === 'POST');
  assert.deepEqual(post?.body, { original: 'Buy now!', comment: 'Too salesy.' });
});
