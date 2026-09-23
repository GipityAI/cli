/**
 * AUTO-GENERATED - do not edit directly.
 * Source: platform/packages/shared/src/brand.ts
 * Run `just sync-brand` (from platform/) to refresh.
 *
 * This package cannot import @easyclaw/shared, so it carries a verbatim
 * copy. Edit the source; this file is overwritten.
 */
/**
 * brand.ts - the single source of truth for the PLATFORM's identity: product
 * and agent names, every hostname and URL, the file conventions a linked
 * project carries on disk, the env-var / HTTP-header / cookie / custom-element
 * / CSS prefixes, the npm scope, and the support addresses.
 *
 * Rebranding starts here. Edit the ATOMS block; everything below it derives.
 * Strings that CANNOT be an import - env-var names read as `process.env.X`,
 * header literals, custom-element tags, code identifiers, and all docs prose -
 * are rewritten mechanically by `npx tsx scripts/rebrand.ts`.
 * See docs-team/product/guides/rebranding.md for the runbook.
 *
 * NOT to be confused with the per-app visual identity a user sets via
 * `gipity brand` (favicons, accent colour, og-image) - that is app-brand.ts.
 *
 * The `cli` and `gipity-mcp` packages ship separately and cannot import
 * `@easyclaw/shared`, so each carries a generated copy of this file.
 * `npx tsx scripts/sync-brand.ts` writes them and `--check` gates drift (the
 * same two-registries pattern as check-agent-registry.ts).
 */

// ---------------------------------------------------------------------------
// ATOMS - the only strings a rebrand has to choose. Everything else derives.
// ---------------------------------------------------------------------------

/** Product name, title case. Appears in every user-facing surface. */
const NAME = 'Gipity';

/** Lowercase slug: CLI binary, config/manifest stems, CSS + element prefixes. */
const SLUG = 'gipity';

/** The cloud agent's name, title case. */
const AGENT_NAME = 'Gip';

/** The agent's lowercase slug: token prefixes, the runner, the `.gip` bundle. */
const AGENT_SLUG = 'gip';

/** Apex domain. Every host below is this or a subdomain of it. */
const APEX = 'gipity.ai';

/** GitHub org owning the public repos (cli, registry, skills). */
const GITHUB_ORG = 'GipityAI';

/** SCREAMING_SNAKE prefix on every env var the platform reads. */
const ENV_PREFIX = 'GIPITY';

/** Prefix on the custom request/response headers (`X-Gipity-Project`). */
const HEADER_PREFIX = 'X-Gipity';

/** npm scope kits are published/imported under. */
const NPM_SCOPE = '@gipity';

/** Mailbox the agent sends from, and the human fallback, both `@APEX`. */
const AGENT_MAILBOX = 'gipity';
const HUMAN_MAILBOX = 'steve';

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

const sub = (label: string): string => `${label}.${APEX}`;

/** Every host the platform owns. Values double as S3 bucket names where the
 *  bucket is named for its host (media / muda / vfs). */
const HOST = {
  apex: APEX,
  www: sub('www'),
  /** Public API + app-services origin. */
  api: sub('a'),
  /** Production app hosting. */
  app: sub('app'),
  /** Dev app hosting. */
  dev: sub('dev'),
  /** Marketing / pricing / login site. */
  marketing: sub('prompt'),
  /** Docs site. */
  docs: sub('docs'),
  /** Permanent media CDN (also the S3 bucket name). */
  media: sub('media'),
  /** Presigned-upload staging bucket. */
  uploads: sub('muda'),
  /** Project file storage bucket. */
  storage: sub('vfs'),
  /** Game/asset CDN. */
  assets: sub('assets'),
  /** Realtime websocket host. */
  realtime: sub('rt'),
  /** CNAME target customers point their own domains at. */
  customDomain: sub('custom'),
  /** Email domain for synthetic connector accounts (Discord/Telegram). */
  connector: sub('connector'),
} as const;

const https = (host: string): string => `https://${host}`;

const URL_ = {
  site: https(HOST.apex),
  api: https(HOST.api),
  app: https(HOST.app),
  dev: https(HOST.dev),
  marketing: https(HOST.marketing),
  docs: https(HOST.docs),
  media: https(HOST.media),
  assets: https(HOST.assets),
  realtime: `wss://${HOST.realtime}`,
  login: `${https(HOST.apex)}/login`,
  pricing: `${https(HOST.marketing)}/pricing`,
  terms: `${https(HOST.apex)}/terms.html`,
  privacy: `${https(HOST.apex)}/privacy.html`,
} as const;

/** On-disk conventions a linked project carries. Renaming any of these is a
 *  breaking change for every existing project, so the codemod also moves the
 *  files - see scripts/rebrand.ts. */
const FILE = {
  /** Per-project link file, found by walking up from cwd. */
  config: `.${SLUG}.json`,
  /** Deploy manifest (files/database/functions/workflows phases). */
  manifest: `${SLUG}.yaml`,
  /** gitignore-style list of paths sync must never see. */
  ignore: `.${SLUG}ignore`,
  /** Per-user state dir under $HOME, and the per-project state dir. */
  homeDir: `.${SLUG}`,
  /** Legacy scratch namespace, never synced and never deployed (`tmp/` is the
   *  one to write to; this is kept as a safety net). No trailing slash. */
  scratchDir: `.${SLUG}scratch`,
  /** Default parent dir for new projects under $HOME. */
  projectsDir: `${NAME}Projects`,
  /** Brand theme stylesheet shipped into Water.css templates. */
  themeCss: `${SLUG}-theme.css`,
  /** Browser SDK served from the media CDN. */
  browserSdk: `${SLUG}.js`,
  /** Sandbox context shims injected into run payloads. */
  sandboxCtxJs: `${SLUG}_ctx.js`,
  sandboxCtxPy: `${SLUG}_ctx.py`,
  /** Portable project bundle extension (".gip project files"). */
  bundleExt: `.${AGENT_SLUG}`,
} as const;

/** Prefixed-name builders. Call sites that need a *literal* (a `process.env.X`
 *  member expression, a `<tag>` in HTML, a docs example) stay literal on
 *  purpose and are handled by the codemod instead. */
const env = (suffix: string): string => `${ENV_PREFIX}_${suffix}`;
const header = (suffix: string): string => `${HEADER_PREFIX}-${suffix}`;
const cookie = (suffix: string): string => `${SLUG}_${suffix}`;
const el = (suffix: string): string => `${SLUG}-${suffix}`;
const cls = (suffix: string): string => `${SLUG}-${suffix}`;
const pkg = (kit: string): string => `${NPM_SCOPE}/${kit}`;

export const BRAND = {
  name: NAME,
  slug: SLUG,
  agentName: AGENT_NAME,
  agentSlug: AGENT_SLUG,

  /** The CLI binary users and agents type. */
  cli: SLUG,
  /** npm package the CLI publishes as. */
  cliPackage: SLUG,
  /** Companion binaries shipped by the CLI package. */
  cliCompanions: [`${AGENT_SLUG}cc`, `${AGENT_SLUG}ccd`] as const,
  /** The GipRunner harness that replays real sessions and files issues. */
  runner: `${AGENT_NAME}Runner`,

  /** `window.Gipity` in the browser SDK. */
  browserGlobal: NAME,

  host: HOST,
  url: URL_,
  file: FILE,

  github: {
    org: GITHUB_ORG,
    cli: `${GITHUB_ORG}/cli`,
    registry: `${GITHUB_ORG}/registry`,
    skills: `${GITHUB_ORG}/skills`,
  },

  email: {
    /** From-address on everything the agent sends. */
    agent: `${AGENT_MAILBOX}@${APEX}`,
    /** Human fallback / system sender. */
    human: `${HUMAN_MAILBOX}@${APEX}`,
    domain: APEX,
  },

  npm: { scope: NPM_SCOPE, pkg },
  env: { prefix: ENV_PREFIX, name: env },
  header: { prefix: HEADER_PREFIX, name: header },
  cookie: { prefix: `${SLUG}_`, name: cookie },
  el: { prefix: `${SLUG}-`, name: el },
  css: { prefix: `${SLUG}-`, name: cls, theme: cls('theme') },

  /** Long-lived agent API token prefix (`gip_at_...`). */
  tokenPrefix: `${AGENT_SLUG}_at_`,
} as const;

/** True for hosts we will attach account tokens to. Shared by the CLI's
 *  apiBase allowlist and the server's CORS/redirect guards, so "is this ours?"
 *  has exactly one definition. */
export function isBrandHost(hostname: string): boolean {
  return hostname === APEX || hostname.endsWith(`.${APEX}`);
}

export type Brand = typeof BRAND;
