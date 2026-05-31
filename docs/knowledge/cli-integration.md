# CLI integration

Guidance for agents working in a Gipity project through the `gipity` CLI.

## Syncing

- `gipity sync` reconciles local files with the project on the server. When a
  file has diverged on both sides the sync layer keeps a single canonical file
  (remote wins on a pull, otherwise local is kept) and warns loudly instead of
  writing a parenthetical `foo (conflict from HOST).ext` copy.
- Run `gipity sync status` (or `gipity sync --status`) and remove any stray
  `* (conflict from …)*` artifacts before declaring a build done — a leftover
  conflict copy means the source tree is silently broken even if the deployed
  app still works off the server's original.
