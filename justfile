# Gipity CLI

# Build CLI (auto-bump patch version, compile TypeScript)
cli-build:
    npm version patch --no-git-tag-version && npm run build

# Publish CLI to npm (build bumps version, then publish)
cli-publish:
    just cli-build && npm publish --access public

# Build and link CLI globally for local dev
cli-link:
    just cli-build && npm link

# Unlink CLI global dev install
cli-unlink:
    npm unlink -g
