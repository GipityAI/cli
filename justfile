# Gipity CLI

set dotenv-load := true

# Sync shared docs from platform (provider models, voices, params) and the
# generated knowledge constants (CLAUDE.md body, build rules). Both write
# committed files under src/ from platform-owned sources.
sync-docs:
    cd ../platform && node --import tsx scripts/export-provider-docs.ts > ../cli/src/provider-docs.ts
    echo "✓ Synced provider-docs.ts from platform"
    cd ../platform && node --import tsx scripts/build-knowledge.ts
    echo "✓ Synced knowledge.ts from platform"

# Build CLI (sync docs, compile TypeScript). No version bump — versions advance
# at publish time only, so local builds/links don't dirty package.json with
# numbers npm has never seen. The npm `postbuild` hook stamps the git SHA into
# the gitignored dist/build-info.json instead, so `gipity -v` shows a
# `(dev <sha>)` marker telling you whether your linked binary is current —
# without touching package.json or shipping in the published tarball.
cli-build:
    just sync-docs && npm run build

# Publish CLI to npm (bump patch, build, publish, record the bump in git).
# The git steps are best-effort: a publish must never fail on them, but an
# unrecorded bump means the next publish from a fresh checkout collides with
# an already-published version — so warn loudly and let `gw ready` flag it.
cli-publish:
    #!/usr/bin/env bash
    set -e
    just sync-docs
    npm version patch --no-git-tag-version
    npm run build
    npm publish --access public
    VER=$(node -p "require('./package.json').version")
    git commit -m "chore: cli v${VER} (npm publish)" -- package.json package-lock.json \
      || { echo "WARN: could not commit version bump — record v${VER} manually"; exit 0; }
    git fetch origin main
    if [ "$(git rev-list --count origin/main..HEAD)" -gt 1 ]; then
      echo "WARN: checkout has other unpushed commits — v${VER} bump committed locally only"
      exit 0
    fi
    git pull --rebase --autostash origin main && git push origin main \
      || echo "WARN: push failed — v${VER} bump committed locally; push manually (gw ready will flag it)"

# Run CLI locally without linking (compile + execute, passes args through)
cli-dev *ARGS:
    npm run build && node dist/index.js {{ARGS}}

# Build and link CLI globally for local dev.
# NOTE: this recipe can't rehash your shell itself (it runs in a subshell), so
# after linking you must `hash -r` or `gipity` keeps resolving to the old path.
# To do both in one step, source scripts/dev-shell.sh from your rc and run the
# `go-cli-link` wrapper instead — it relinks AND rehashes your current shell.
cli-link:
    npm uninstall -g gipity 2>/dev/null; npm unlink -g 2>/dev/null; just cli-build && npm link
    @echo ""
    @echo "✓ Linked. Now run: hash -r   (or use 'go-cli-link' from scripts/dev-shell.sh, which does it for you)"

# Reset to a clean first-run state: run `gipity uninstall` (stops daemon,
# removes autostart, revokes device, wipes ~/.gipity/), then rebuild + relink,
# log in with dev creds from .env, and start the relay in the foreground.
# Useful for testing the first-run flow end-to-end.
cli-reinstall:
    -gipity uninstall --yes
    just cli-link
    gipity login --email "$GIPITY_DEV_EMAIL" --code "$GIPITY_DEV_CODE"
    gipity relay run

# Unlink CLI global dev install
cli-unlink:
    npm uninstall -g gipity 2>/dev/null; npm unlink -g
    @echo ""
    @echo "✓ Unlinked the binary. Note: this does NOT stop the relay daemon, remove the"
    @echo "  OS autostart service, or clear ~/.gipity/. For a true reset, run:"
    @echo "    gipity uninstall"
    @echo "  …BEFORE unlinking."
    @echo ""
    @echo "The binary is gone, but THIS shell still caches its old path. Run:"
    @echo "    hash -r"
    @echo "…in this shell, or open a new one."
