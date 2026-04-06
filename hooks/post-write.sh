#!/bin/bash
# PostToolUse hook: push file to Gipity after Write/Edit
# Runs after CC's Write or Edit tool. Fires gipity push in background.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if no file path extracted
[ -z "$FILE_PATH" ] && exit 0

# Skip if not a Gipity project
[ ! -f ".gipity.json" ] && exit 0

# Push in background, suppress output
gipity push "$FILE_PATH" --quiet &
disown
exit 0
