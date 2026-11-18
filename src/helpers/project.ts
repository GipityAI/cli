import { resolveProjectContext } from '../config.js';

/** The `--project` option every project-scoped command takes: `.option(...PROJECT_OPTION)`. */
export const PROJECT_OPTION = ['--project <guid-or-slug>', 'Target a specific project instead of cwd / Home'] as const;

/** The project guid a command acts on: `--project`, else the linked cwd / Home. */
export async function projectGuidFor(opts: { project?: string }): Promise<string> {
  const { config } = await resolveProjectContext({ projectOverride: opts.project });
  return config.projectGuid;
}
