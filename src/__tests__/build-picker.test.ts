/**
 * Project-picker search matcher (`gipity build` → "Search projects").
 *
 * The interactive paging loop itself needs a TTY, so these tests pin the
 * pure matching contract it is built on: case-insensitive substring over
 * BOTH name and slug, always against the full list (search never narrows
 * a previous search's subset - the browser re-runs it over `all`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchProjects } from '../commands/build.js';

const P = (name: string, slug: string) => ({ short_guid: slug, name, slug });

const projects = [
  P('Stream Deck', 'stream-deck'),
  P('Dream Journal', 'dream-journal'),
  P('Upstream Monitor', 'upstream-monitor'),
  P('Karaoke Night', 'karaoke-night'),
  P('project-042', 'project-042'),
];

describe('searchProjects', () => {
  it('matches a substring anywhere in the name, case-insensitively', () => {
    const hits = searchProjects(projects, 'STREAM');
    assert.deepEqual(hits.map(p => p.slug), ['stream-deck', 'upstream-monitor']);
  });

  it('matches on slug even when the name differs', () => {
    // "journal" appears in both name and slug; "dream-j" only in the slug form.
    const hits = searchProjects(projects, 'dream-j');
    assert.deepEqual(hits.map(p => p.slug), ['dream-journal']);
  });

  it('preserves the original (recency) order of the full list', () => {
    const hits = searchProjects(projects, 'r');
    assert.deepEqual(
      hits.map(p => p.slug),
      ['stream-deck', 'dream-journal', 'upstream-monitor', 'karaoke-night', 'project-042'],
    );
  });

  it('returns the full list for an empty or whitespace-only query', () => {
    assert.equal(searchProjects(projects, '').length, projects.length);
    assert.equal(searchProjects(projects, '   ').length, projects.length);
  });

  it('trims the query before matching', () => {
    const hits = searchProjects(projects, '  karaoke  ');
    assert.deepEqual(hits.map(p => p.slug), ['karaoke-night']);
  });

  it('returns an empty array when nothing matches', () => {
    assert.deepEqual(searchProjects(projects, 'zzz-no-such'), []);
  });
});
