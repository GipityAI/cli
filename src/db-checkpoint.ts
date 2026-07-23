/**
 * Database checkpoint / restore — the undo for a LIVE write test.
 *
 * Verifying a write path for real (clicking Approve in the deployed UI, calling
 * a function that inserts, letting a scheduled workflow run) mutates the
 * project's real data, and there was no way to put it back - agents ended up
 * hand-writing SQL to scrub their own test strings out.
 *
 * The snapshot itself is the SERVER's job: it lives in a sibling schema the app
 * can't see, and restore runs in one transaction. This module is just the
 * client - the CLI never composes checkpoint DDL, so a snapshot can never show
 * up in `db query`, in a migration diff, or in app code that enumerates tables.
 */
import { get, post } from './api.js';

interface DatabaseEntry {
  friendlyName: string;
}

export interface CheckpointResult {
  /** Friendly database name, echoed for output. */
  database: string;
  /** Tables snapshotted (create), put back (restore), or discarded (drop). */
  tables: string[];
  /** Rows snapshotted (create) or put back (restore). */
  rows: number;
}

/** First database in the project, or null when the project has none. */
export async function resolveDatabase(projectGuid: string, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const res = await get<{ data: DatabaseEntry[] }>(`/projects/${projectGuid}/databases`);
  return res.data.length > 0 ? res.data[0].friendlyName : null;
}

async function checkpoint(
  projectGuid: string,
  database: string,
  action: 'create' | 'restore' | 'drop',
  keep?: boolean,
): Promise<CheckpointResult> {
  const res = await post<{ data: CheckpointResult }>(
    `/projects/${projectGuid}/db/checkpoint`,
    { database, action, ...(keep ? { keep } : {}) },
  );
  return res.data;
}

/** Snapshot every app table. Replaces any previous checkpoint. */
export function createCheckpoint(projectGuid: string, database: string): Promise<CheckpointResult> {
  return checkpoint(projectGuid, database, 'create');
}

/**
 * Put every checkpointed table back to its snapshot contents and drop the
 * snapshot (unless `keep`). Sequences are deliberately NOT rewound - leaving
 * them ahead keeps ids unique against anything the test run handed out.
 */
export function restoreCheckpoint(
  projectGuid: string,
  database: string,
  opts: { keep?: boolean } = {},
): Promise<CheckpointResult> {
  return checkpoint(projectGuid, database, 'restore', opts.keep);
}

/** Drop the checkpoint without restoring (keep whatever the run wrote). */
export function dropCheckpoint(projectGuid: string, database: string): Promise<CheckpointResult> {
  return checkpoint(projectGuid, database, 'drop');
}
