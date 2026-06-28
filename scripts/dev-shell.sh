# Gipity CLI — developer shell helpers.
#
# Source this from your shell rc to get convenience commands for local CLI
# development. Add ONE line to your ~/.bashrc (or ~/.zshrc), pointing at your
# own checkout:
#
#     source /path/to/Gipity/cli/scripts/dev-shell.sh
#
# Then open a new shell (or re-source your rc). Works in bash and zsh.
#
# ── Helpers ──────────────────────────────────────────────────────────────────
#
#   go-cli-link   Rebuild + globally link the CLI from the checkout you're
#                 standing in, then rehash THIS shell so `gipity` resolves to the
#                 fresh build immediately.
#
#                 Why a shell function and not just a justfile step: `just
#                 cli-link` (like `npm link` itself) runs in a subshell, and a
#                 child process can't rehash its parent's command-hash table. So
#                 after a relink your interactive shell keeps resolving `gipity`
#                 to the OLD path until you run `hash -r` by hand — a classic
#                 footgun (you relink, rerun `gipity`, and still get the stale
#                 binary). This wrapper runs the recipe and then rehashes the
#                 current shell, so the new link takes effect right away. Run it
#                 from inside the cli repo/worktree you want to link; it only
#                 rehashes on a successful build.

go-cli-link() {
  just cli-link && hash -r && echo "↻ rehashed → $(command -v gipity)"
}
