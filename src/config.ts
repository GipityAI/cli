import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface GipityConfig {
  projectGuid: string;
  projectSlug: string;
  accountSlug: string;
  agentGuid: string;
  conversationGuid: string | null;
  apiBase: string;
  ignore: string[];
}

const CONFIG_FILE = '.gipity.json';

let cached: GipityConfig | null = null;
let cachedPath: string | null = null;

/** Find .gipity.json starting from cwd and walking up */
function findConfigPath(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null; // reached root
    dir = parent;
  }
}

export function getConfigPath(): string | null {
  if (cachedPath !== null) return cachedPath;
  cachedPath = findConfigPath();
  return cachedPath;
}

export function getConfig(): GipityConfig | null {
  if (cached) return cached;
  const path = getConfigPath();
  if (!path) return null;
  try {
    cached = JSON.parse(readFileSync(path, 'utf-8'));
    return cached;
  } catch {
    return null;
  }
}

export function requireConfig(): GipityConfig {
  const config = getConfig();
  if (!config) {
    console.error('Not a Gipity project. Run: gipity init');
    process.exit(1);
  }
  return config;
}

export function clearConfigCache(): void {
  cached = null;
  cachedPath = null;
}

export function saveConfig(data: GipityConfig): void {
  const path = getConfigPath() || resolve(process.cwd(), CONFIG_FILE);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  cached = data;
  cachedPath = path;
}

export function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    // Simple glob matching: exact match, prefix match, or extension match
    if (filePath === pattern) return true;
    if (filePath.startsWith(pattern + '/')) return true;
    if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) return true;
    if (pattern.endsWith('/') && filePath.startsWith(pattern)) return true;
    // Directory name match anywhere in path
    if (!pattern.includes('*') && !pattern.includes('/')) {
      if (filePath.split('/').includes(pattern)) return true;
    }
  }
  return false;
}
