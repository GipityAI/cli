import { get } from './api.js';
import { getConfig } from './config.js';
import { muted } from './colors.js';

/** Maps CLI command names to the skill that should auto-load on --help. */
export const HELP_SKILL_MAP: Record<string, string> = {
  fn: 'app-development',
  db: 'app-development',
};

interface SkillSummary { guid: string; name: string; }
interface SkillDetail { content: string; }

/**
 * Fetch a skill by name from the server and print its content.
 * Silent on failure (no auth, no network, no config = just skip).
 */
export async function fetchAndPrintSkill(skillName: string): Promise<void> {
  try {
    const config = getConfig();
    if (!config) return;

    const listRes = await get<{ data: SkillSummary[] }>(`/skills?agent=${config.agentGuid}`);
    const match = listRes.data.find(s => s.name.toLowerCase() === skillName.toLowerCase());
    if (!match) return;

    const res = await get<{ data: SkillDetail }>(`/skills/${match.guid}?agent=${config.agentGuid}`);
    if (res.data.content) {
      console.log(muted(`\n── Skill: ${skillName} (auto-loaded from server) ──\n`));
      console.log(res.data.content);
    }
  } catch {
    // Silent — help still works without the skill
  }
}
