# Gip commands (archived 2026-09-23)

`gipity chat` (talk to Gip) and `gipity agent` (manage the project's Gip agent: model, soul, goal, rules) left the CLI when Gip was archived (`platform/docs-team/product/specs/gipity-refocus.md`). Not built or tested. `archive/gip/src/api-send-message.ts` is the chat send helper from `src/api.ts`.

`gipity memory` stayed, scoped to the project (the notes workflow `llm` steps read and write). `gipity approval` and `gipity gmail` stayed.
