#!/bin/bash
# UserPromptSubmit hook: sync check before each CC turn
# Pulls remote changes and reports diff as systemMessage.

# Skip if not a Gipity project
[ ! -f ".gipity.json" ] && exit 0

# Sync down with JSON output
RESULT=$(gipity sync down --json 2>/dev/null)

# Check if any files were pulled
PULLED=$(echo "$RESULT" | jq -r '.pulled // 0' 2>/dev/null)

if [ "$PULLED" -gt 0 ]; then
  SUMMARY=$(echo "$RESULT" | jq -r '.summary // "Files changed remotely."' 2>/dev/null)
  # Output systemMessage so CC sees the diff
  echo "{\"systemMessage\": \"Gipity sync: ${SUMMARY}\"}"
fi

exit 0
