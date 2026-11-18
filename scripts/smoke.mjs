// The full CLI smoke gate (`npm run test:smoke`, after the build): runs every test
// listed in test-smoke.txt against dist/.
import { execFileSync } from 'node:child_process';
import { readSmokeList, distTest } from './smoke-list.mjs';

try {
  execFileSync('node', ['--test', ...readSmokeList().map(distTest)], { stdio: 'inherit' });
} catch (e) {
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
