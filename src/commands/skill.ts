import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { get } from '../api.js';
import { resolveProjectContext, getProjectRoot } from '../config.js';
import { error as clrError, bold, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

/** Many kits ship a README but no skill doc. When `skill read <name>` misses
 *  the server catalog, fall back to an installed kit's README so the canonical
 *  lookup doesn't dead-end. Returns the README text, or null if no such kit. */
function readInstalledKitReadme(name: string): string | null {
  const root = getProjectRoot() ?? process.cwd();
  const kitDir = join(root, 'src', 'packages', name);
  if (!existsSync(join(kitDir, 'package.json'))) return null;
  const readme = join(kitDir, 'README.md');
  return existsSync(readme) ? readFileSync(readme, 'utf-8') : null;
}

interface SkillSummary {
  guid: string;
  name: string;
  description: string;
  scope: string;
}

interface SkillDetail extends SkillSummary {
  content: string;
}

// ─── Doc structure ──────────────────────────────────────────────────────────
//
// `skill read` used to be all-or-nothing: the whole doc or nothing. Agents
// budgeting context piped every read through a guessed `head -N` (and grepped
// the output when they wanted one fact), so guidance past the cut was silently
// dropped and nothing told them the doc was longer than what they read. The
// outline below powers three fixes: a one-line map above every read (survives
// `head -N`, so a truncated read is visibly truncated), `--toc`, and targeted
// `--section` / `--grep` reads.

interface Section {
  level: number;
  title: string;
  slug: string;
  /** 1-based first/last line of the section, subsections included. */
  start: number;
  end: number;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Markdown headings, skipping anything inside a fenced code block (shell
 *  comments in examples start with `#` too). A section runs until the next
 *  heading at the same or a shallower level, so it carries its subsections. */
function parseSections(lines: string[]): Section[] {
  const out: Section[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (!m) return;
    out.push({ level: m[1].length, title: m[2], slug: slugify(m[2]), start: i + 1, end: lines.length });
  });
  out.forEach((s, i) => {
    const next = out.find((o, j) => j > i && o.level <= s.level);
    if (next) s.end = next.start - 1;
  });
  return out;
}

/** The heading level worth listing in the one-line map: the shallowest level
 *  with more than one heading (docs open with a single `# Title`, so that lone
 *  H1 is never the useful outline), else the shallowest level present. */
function outlineLevel(sections: Section[]): number {
  const levels = [...new Set(sections.map(s => s.level))].sort((a, b) => a - b);
  return levels.find(l => sections.filter(s => s.level === l).length > 1) ?? levels[0];
}

function sectionText(lines: string[], s: Section): string {
  return lines.slice(s.start - 1, s.end).join('\n').replace(/\s+$/, '');
}

const MAX_MAPPED_SECTIONS = 12;

/** One line above every read: how long the doc is and what is in it, with the
 *  flag for pulling one part inline. Printed to stdout so it survives an
 *  agent's `| head -N`. */
function mapLine(name: string, lines: string[], sections: Section[]): string {
  const head = `${bold(name)} ${muted(`· ${lines.length} lines`)}`;
  if (sections.length === 0) return head;
  const shown = sections.filter(s => s.level === outlineLevel(sections));
  const names = shown.slice(0, MAX_MAPPED_SECTIONS).map(s => s.slug).join(', ');
  const more = shown.length > MAX_MAPPED_SECTIONS ? `, +${shown.length - MAX_MAPPED_SECTIONS} more (--toc)` : '';
  return `${head} ${muted(`· sections (--section <slug>): ${names}${more}`)}`;
}

function tocText(sections: Section[]): string {
  return sections
    .map(s => `${String(s.start).padStart(5)}  ${'  '.repeat(s.level - 1)}${s.slug}${muted(` - ${s.title}`)}`)
    .join('\n');
}

interface ReadOpts { json?: boolean; toc?: boolean; section?: string; grep?: string; }

/** Apply --toc / --section / --grep to a doc. Returns the text to print, or
 *  null when the filter matched nothing (caller reports it and exits 1). */
function filterContent(content: string, sections: Section[], opts: ReadOpts): string | null {
  const lines = content.split('\n');
  if (opts.toc) return tocText(sections);

  let hits: Section[] = [];
  if (opts.section) {
    const want = slugify(opts.section);
    hits = sections.filter(s => s.slug === want);
    if (hits.length === 0) hits = sections.filter(s => s.slug.includes(want));
  } else if (opts.grep) {
    let re: RegExp;
    try { re = new RegExp(opts.grep, 'i'); }
    catch { throw new Error(`--grep "${opts.grep}" is not a valid regex.`); }
    // Deepest matching section per hit: the smallest chunk that still answers
    // the question, rather than the whole chapter it sits in.
    const matched = new Set<Section>();
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      const owning = sections.filter(s => s.start <= i + 1 && i + 1 <= s.end);
      const deepest = owning[owning.length - 1];
      if (deepest) matched.add(deepest);
    });
    hits = sections.filter(s => matched.has(s));
  } else {
    return content;
  }

  if (hits.length === 0) return null;
  // Drop sections already contained in an outer hit so nothing prints twice.
  const outer = hits.filter(s => !hits.some(o => o !== s && o.start <= s.start && s.end <= o.end));
  return outer.map(s => sectionText(lines, s)).join('\n\n');
}

export const skillCommand = new Command('skill')
  .description('Task docs - read the matching skill before building');

skillCommand
  .command('list')
  .description('List skills')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const { config } = await resolveProjectContext();
    if (!config.agentGuid) {
      console.error(clrError('No agent configured for this project. Run `gipity init` to refresh.'));
      process.exit(1);
    }
    const res = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);

    const width = res.data.reduce((m, s) => Math.max(m, s.name.length), 0);
    printList(res.data, opts, 'No skills available.', s =>
      `  ${bold(s.name.padEnd(width))}  ${muted(s.description)}`,
      'Read with `gipity skill read <name> [<name>...]` (one turn, many docs; `--toc`, `--section <slug>` or `--grep <term>` for one part):'
    );
  }));

skillCommand
  .command('read <names...>')
  .description('Read one or more skills (whole doc, or one part with --toc/--section/--grep)')
  .option('--toc', 'Print the doc outline (section slugs + line numbers) instead of the content')
  .option('--section <slug>', 'Print only this section (slug or heading text; subsections included)')
  .option('--grep <term>', 'Print only the sections matching this term (case-insensitive regex)')
  .option('--json', 'Output as JSON')
  .action((names: string[], opts: ReadOpts) => run('Read', async () => {
    const { config } = await resolveProjectContext();
    if (!config.agentGuid) {
      console.error(clrError('No agent configured for this project. Run `gipity init` to refresh.'));
      process.exit(1);
    }
    const listRes = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);

    const jsonDocs: unknown[] = [];
    let failed = false;
    let printed = 0;

    for (const name of names) {
      const match = listRes.data.find(s => s.name.toLowerCase() === name.toLowerCase());
      let content: string;
      let detail: Record<string, unknown>;
      let note: string | null = null;

      if (match) {
        const res = await get<{ data: SkillDetail }>(`/skills/${match.guid}?agent=${config.agentGuid}`);
        content = res.data.content;
        detail = { ...res.data };
      } else {
        // No catalog skill — but if a kit by this name is installed, its README is
        // the guidance the agent is after. Surface it instead of dead-ending.
        const readme = readInstalledKitReadme(name);
        if (!readme) {
          console.error(clrError(`Skill "${name}" not found. Run: gipity skill list`));
          failed = true;
          continue;
        }
        content = readme;
        detail = { name, source: 'kit-readme' };
        note = muted(`No skill doc for "${name}"; showing the installed kit's README (src/packages/${name}/README.md):`);
      }

      const lines = content.split('\n');
      const sections = parseSections(lines);
      const filtered = filterContent(content, sections, opts);
      if (filtered === null) {
        const what = opts.section ? `section "${opts.section}"` : `match for "${opts.grep}"`;
        console.error(clrError(`No ${what} in "${name}". Sections: ${sections.map(s => s.slug).join(', ') || '(none)'}`));
        failed = true;
        continue;
      }

      if (opts.json) {
        jsonDocs.push({
          ...detail,
          content: filtered,
          lines: lines.length,
          sections: sections.map(s => ({ slug: s.slug, title: s.title, level: s.level, line: s.start })),
        });
        continue;
      }
      if (printed > 0) console.log('');  // blank line between docs in a multi-name read
      if (note) console.log(note);
      console.log(mapLine(name, lines, sections));
      console.log(filtered);
      printed++;
    }

    if (opts.json) {
      console.log(JSON.stringify(names.length === 1 ? jsonDocs[0] ?? null : jsonDocs, null, 2));
    }
    if (failed) process.exit(1);
  }));
