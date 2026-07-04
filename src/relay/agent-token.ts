/**
 * Long-lived agent API token for relay-spawned children.
 *
 * The daemon itself authenticates with its device token, but the children it
 * spawns (`gipity sync`, `gipity claude -p`) used to fall back to the shared
 * session in ~/.gipity/auth.json - and with up to 6 concurrent dispatches,
 * sibling processes raced each other on the session's SINGLE-USE refresh
 * token, intermittently failing with "Session expired" mid-dispatch.
 *
 * Instead, the daemon holds a long-lived gip_at_* agent API token (minted
 * once, stored in relay.json 0600 next to the device token) and exports it
 * to every child as GIPITY_TOKEN. The CLI's auth layer prefers an env token
 * over the session, so children authenticate statelessly - no refresh, no
 * lock, no race. If minting fails (e.g. daemon started at boot with an
 * expired session), we return null and children fall back to the session
 * path, which is exactly the old behavior.
 */
import { hostname } from 'os';
import { post, del } from '../api.js';
import { resolveApiBase } from '../config.js';
import * as state from './state.js';

/** Validate a stored token against the API. Only a definitive 401 counts as
 *  invalid - transient failures (network, 5xx) must not discard a good token
 *  and trigger a re-mint storm. */
async function tokenValid(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${resolveApiBase()}/users/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.status !== 401;
  } catch {
    return true; // network blip - assume still valid
  }
}

/**
 * Return the relay's agent token, minting one if absent or revoked. Minting
 * uses the caller's normal session auth (the daemon process is logged in),
 * so it can fail when the session is dead - callers treat null as "children
 * use session auth" (graceful degradation to the old behavior).
 */
export async function ensureRelayAgentToken(): Promise<string | null> {
  const existing = state.getAgentToken();
  if (existing) {
    if (await tokenValid(existing.token)) return existing.token;
    state.setAgentToken(null, null); // revoked/expired - drop and re-mint
  }

  try {
    const name = `Relay on ${state.getDevice()?.name ?? hostname()}`;
    const res = await post<{ data: { token: string; shortGuid: string } }>(
      '/auth/agent-tokens',
      { name },
    );
    state.setAgentToken(res.data.token, res.data.shortGuid);
    return res.data.token;
  } catch {
    return null;
  }
}

/** Best-effort server-side revocation of the relay's agent token (used when
 *  the device is unpaired). Local state is cleared by clearDevice() either
 *  way; a failed server call just leaves a dead-weight token the user can
 *  still see and revoke with `gipity token list` / `revoke`. */
export async function revokeRelayAgentToken(): Promise<boolean> {
  const existing = state.getAgentToken();
  if (!existing?.guid) return false;
  try {
    await del(`/auth/agent-tokens/${encodeURIComponent(existing.guid)}`);
    return true;
  } catch {
    return false;
  }
}
