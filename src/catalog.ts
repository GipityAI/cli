/**
 * The `gipity add` catalog - template + kit keys with terse list hints.
 *
 * AUTO-GENERATED - do not edit directly.
 * Source: platform/packages/shared/src/constants.ts (TEMPLATES/KITS cliHint fields)
 * Run `just build-knowledge` to refresh.
 */

export interface CatalogEntry { key: string; hint: string; }

/** Visible starter templates (complete working demos). */
export const STARTERS: CatalogEntry[] = [
  { key: 'web-vision-cam', hint: 'fullscreen camera app with on-device vision (MediaPipe)' },
  { key: 'object-spotter', hint: 'camera app that boxes, labels, and counts objects (YOLOX on-device)' },
  { key: '2d-game', hint: '2D games with Phaser 3 - platformer, arcade, puzzle' },
  { key: '3d-world', hint: 'playable 3D multiplayer rocket-launcher demo' },
  { key: 'karaoke-captions', hint: 'audio + lyrics -> word-synced karaoke captions (GPU job)' },
  { key: 'outreach-agent', hint: 'AI-run outreach funnel - import contacts, draft + auto-send staged emails' },
  { key: 'paid-app', hint: 'storefront that charges real money - Stripe checkout, members area, billing' },
  { key: 'notify-demo', hint: 'web-push demo - enable notifications, send a real ping' },
];

/** Visible blank-wiring templates. */
export const BLANK: CatalogEntry[] = [
  { key: 'web-simple', hint: 'static frontend-only site - pages, dashboards, simple games' },
  { key: 'web-fullstack', hint: 'backend API + database wiring - frontend, functions, migrations; deploys green' },
  { key: '3d-engine', hint: '3D multiplayer wiring - Three.js + Rapier + Gipity Realtime' },
  { key: 'api', hint: 'pure API backend, no frontend - one example function + test' },
];

/** Hidden templates - installable by exact key, omitted from listings. */
export const HIDDEN: CatalogEntry[] = [
  { key: 'app-itsm', hint: 'IT service management / helpdesk / ticketing' },
  { key: 'monitor', hint: 'account observability dashboard (auto-installed per account)' },
];

/** Kits - building blocks added into an existing app. */
export const KITS: CatalogEntry[] = [
  { key: 'realtime', hint: 'multiplayer / presence / shared state' },
  { key: 'web-vision-mediapipe', hint: 'browser camera vision - gesture, pose, object detection' },
  { key: 'web-vision-detect', hint: 'browser object detection - YOLOX, WebGPU/WASM, custom models' },
  { key: 'chatbot', hint: 'drop-in chatbot - persona, guardrails, streaming responses' },
  { key: 'audio-align', hint: 'audio + lyrics -> word-level timing JSON (GPU job)' },
  { key: 'i18n', hint: 'multi-language web apps - language picker, RTL, translations' },
  { key: 'records', hint: 'registry-driven data plane - generic CRUD, validation, search, audit spine' },
  { key: 'views', hint: 'registry-driven UI over records - table, forms, kanban' },
  { key: 'agent-api', hint: 'named API keys for agent/script writes through the records kit' },
  { key: 'contacts', hint: 'multi-source contact layer - LinkedIn/Gmail import, dedupe with provenance' },
  { key: 'stripe', hint: 'charge your users - Stripe checkout, subscriptions, brokered webhooks' },
  { key: 'notify', hint: 'web push notifications - platform-owned keys, works on iOS home screen' },
  { key: 'servicenow', hint: 'ServiceNow tables as a data source - OAuth pull/write-back, any table' },
];
