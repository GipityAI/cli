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

# Build CLI (sync docs, auto-bump patch version, compile TypeScript)
cli-build:
    just sync-docs && npm version patch --no-git-tag-version && npm run build

# Publish CLI to npm (build bumps version, then publish)
cli-publish:
    just cli-build && npm publish --access public

# Run CLI locally without linking (compile + execute, passes args through)
cli-dev *ARGS:
    npm run build && node dist/index.js {{ARGS}}

# Build and link CLI globally for local dev
cli-link:
    npm uninstall -g gipity 2>/dev/null; npm unlink -g 2>/dev/null; just cli-build && npm link
    @echo ""
    @echo "✓ Linked. If 'gipity' still points to a stale path in THIS shell, run: hash -r"

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
