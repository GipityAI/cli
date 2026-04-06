# Gipity CLI

# Build CLI (compile TypeScript)
cli-build:
    npm run build

# Publish CLI to npm (build + publish)
cli-publish:
    npm run build && npm publish --access public

# Build and link CLI globally for local dev
cli-link:
    npm run build && npm link

# Unlink CLI global dev install
cli-unlink:
    npm unlink -g
