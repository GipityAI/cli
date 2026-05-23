/**
 * Unit tests for the relay machine-id fingerprint. The native-id paths
 * (Linux/macOS/Windows) are environment-specific; these cover the public
 * guarantees: a uniform 64-char hex output, determinism, and that the
 * GIPITY_RELAY_MACHINE_ID override drives the value (the path hosted
 * relay-host containers rely on).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMachineId } from '../relay/machine-id.js';

const ORIG = process.env.GIPITY_RELAY_MACHINE_ID;

describe('getMachineId', () => {
  afterEach(() => {
    if (ORIG === undefined) delete process.env.GIPITY_RELAY_MACHINE_ID;
    else process.env.GIPITY_RELAY_MACHINE_ID = ORIG;
  });

  it('returns a uniform 64-char lowercase hex string', () => {
    assert.match(getMachineId(), /^[0-9a-f]{64}$/);
  });

  it('is deterministic for a fixed override', () => {
    process.env.GIPITY_RELAY_MACHINE_ID = 'relay-host:alice@example.com';
    const a = getMachineId();
    const b = getMachineId();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('different overrides produce different ids', () => {
    process.env.GIPITY_RELAY_MACHINE_ID = 'relay-host:alice@example.com';
    const alice = getMachineId();
    process.env.GIPITY_RELAY_MACHINE_ID = 'relay-host:bob@example.com';
    const bob = getMachineId();
    assert.notEqual(alice, bob);
  });

  it('an empty override is ignored (falls through to a real id)', () => {
    process.env.GIPITY_RELAY_MACHINE_ID = '   ';
    assert.match(getMachineId(), /^[0-9a-f]{64}$/);
  });
});
