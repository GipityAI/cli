// Real platform e2e for `gipity workflow` against the live server. Skipped
// unless GIPITY_E2E=1. This is the non-circular complement to the mocked
// cli-cmd-workflow tests: it proves the actual server routes exist and behave,
// exercising the full CRUD + run surface the CLI straddles (it resolves names
// via the project-scoped tree and mutates via the account-global tree).
//
// Cost profile: ~$0.001 (one tiny LLM step when the manual workflow is run;
// the run is fire-and-forget, the CLI only asserts the trigger was accepted).
// Dev-bypass auth (914914) with an `ec-` prefixed @914-6.com email.
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-wf@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-wf@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

const WF_NAME = `e2e-wf-${Date.now().toString(36)}`;
const WF_YAML_PATH = 'workflows/e2e.yaml';
// Minimal manual workflow: one cheap LLM step. `trigger: manual` avoids the
// per-plan cron-interval limits; no agent_guid is needed (agentId stays null).
const WF_YAML = `name: ${WF_NAME}
description: E2E live test workflow (auto-deleted)
trigger: manual
steps:
  - name: greet
    prompt: "Reply with exactly: ok"
    model_id: claude-haiku-4-5
`;

describe('cli-e2e-workflow-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-wf-'));
  const projectSlug = `gip-e2e-wf-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };

  const cli = (args: string[], opts: { timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: projectDir, timeout: opts.timeout ?? 60000, enableUpdater: false,
    });

  before(() => {
    const login = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(login.status, 0, `login failed: ${login.stderr || login.stdout}`);

    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

    // Write the workflow YAML and push it to project storage so the server's
    // create-from-YAML path can read it back out of the project's files.
    mkdirSync(join(projectDir, 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, WF_YAML_PATH), WF_YAML);
    const push = cli(['push', WF_YAML_PATH]);
    assert.equal(push.status, 0, `push failed: ${push.stderr || push.stdout}`);
  });

  after(() => {
    try { cli(['-y', 'workflow', 'delete', WF_NAME]); } catch { /* ignore */ }
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. create --from <yaml> creates the workflow (POST /workflows, reads project YAML)', () => {
    const r = cli(['workflow', 'create', '--from', WF_YAML_PATH]);
    assert.equal(r.status, 0, `create failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, /Workflow created/);
  });

  it('2. list shows the workflow (GET /workflows, scoped to this project)', () => {
    const r = cli(['workflow', '--json']);
    assert.equal(r.status, 0, `list failed: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.ok(res.data.some((w: { name: string }) => w.name === WF_NAME), `workflow ${WF_NAME} not in list`);
  });

  it('3. info <name> resolves by name (via /workflows) and shows details (GET /workflows/:guid)', () => {
    const r = cli(['workflow', 'info', WF_NAME]);
    assert.equal(r.status, 0, `info failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, new RegExp(`Name:\\s+${WF_NAME}`));
    assert.match(r.stdout, /Trigger:\s+manual/);
    assert.match(r.stdout, /greet/); // the step name from the YAML
  });

  it('4. run <name> triggers the workflow (POST /workflows/:guid/run)', () => {
    const r = cli(['workflow', 'run', WF_NAME], { timeout: 60000 });
    assert.equal(r.status, 0, `run failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, new RegExp(`Triggered "${WF_NAME}"`));
  });

  it('5. runs <name> lists run history (GET /workflows/:guid/runs)', () => {
    const r = cli(['workflow', 'runs', WF_NAME]);
    assert.equal(r.status, 0, `runs failed: ${r.stderr || r.stdout}`);
    assert.doesNotMatch(r.stdout, /undefined/);
  });

  it('6. enable <name> activates and verifies (PUT /workflows/:guid)', () => {
    const r = cli(['workflow', 'enable', WF_NAME]);
    assert.equal(r.status, 0, `enable failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, new RegExp(`Enabled "${WF_NAME}"`));
  });

  it('7. disable <name> deactivates and verifies (PUT /workflows/:guid)', () => {
    const r = cli(['workflow', 'disable', WF_NAME]);
    assert.equal(r.status, 0, `disable failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, new RegExp(`Disabled "${WF_NAME}"`));
  });

  it('8. delete <name> soft-deletes and verifies it went inactive (DELETE /workflows/:guid)', () => {
    const r = cli(['workflow', 'delete', WF_NAME]);
    assert.equal(r.status, 0, `delete failed: ${r.stderr || r.stdout}`);
    assert.match(r.stdout, new RegExp(`Deleted "${WF_NAME}"`));
  });
});
