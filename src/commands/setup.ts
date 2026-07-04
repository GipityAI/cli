/**
 * `gipity setup` — get this computer ready as a relay, then stop.
 *
 * Runs the SAME first steps as `gipity claude` (log in, then pair + start the
 * relay + install the OS login service) but does NOT pick a project or launch
 * Claude Code. For the user who wants their machine available as a relay in the
 * web CLI without being dropped into a coding session.
 *
 * Shares one implementation with `gipity claude`: auth via `login-flow.ts`,
 * relay setup via `relay/onboarding.ts` (`runRelaySetup`). Nothing to maintain
 * twice.
 */
import { Command } from 'commander';
import { getAuth, sessionExpired, refreshTokenIfNeeded } from '../auth.js';
import { interactiveLogin } from '../login-flow.js';
import { runRelaySetup } from '../relay/onboarding.js';
import * as relayState from '../relay/state.js';
import { bold, brand, success, muted, error as clrError } from '../colors.js';

export const setupCommand = new Command('setup')
  .description('Set up this computer as a relay (no project, no launch)')
  .action(async () => {
    try {
      console.log('');
      console.log(`  ${bold('Gipity setup')} ${muted('- get this computer ready as a relay')}`);
      console.log('');

      // ── Step 1: Auth ──────────────────────────────────────────────────
      let auth = getAuth();
      if (auth && !sessionExpired()) {
        await refreshTokenIfNeeded();
        auth = getAuth();
        console.log(`  Logged in (${auth?.email}).`);
      } else {
        if (auth) console.log(`  ${muted('Your session expired. Let\'s sign you back in.')}\n`);
        else console.log('  Let\'s get you logged in.\n');
        auth = await interactiveLogin();
      }
      console.log('');

      // ── Step 2: Relay setup (always run — the user asked for it) ───────
      const enabled = await runRelaySetup({ mode: 'run-now' });

      // ── Step 3: Done. No project, no Claude Code launch. ──────────────
      if (enabled) {
        const running = relayState.isRelayEnabled() && !relayState.isPaused();
        console.log(`  ${success('Done')} — your relay ${running ? 'is running in the background' : 'is set up'} and will start with your computer.`);
        console.log(`  ${muted('Open')} ${brand('gipity.ai')} ${muted('and start a chat to drive Claude Code here. Manage it with `gipity relay status`.')}`);
      } else {
        console.log(`  ${muted('No relay set up. Run `gipity setup` again anytime, or `gipity claude` to build with Gipity.')}`);
      }
      console.log('');
    } catch (err: any) {
      console.error(`\n  ${clrError(`Error: ${err.message}`)}`);
      process.exit(1);
    }
  });
