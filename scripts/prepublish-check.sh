#!/usr/bin/env bash
# Pre-publish validation for @delega-dev/mcp
# Fails npm publish if any check fails.
# Task #219

set -euo pipefail

ERRORS=0

# 1. Check server.json exists
if [ ! -f server.json ]; then
  echo "❌ server.json not found" >&2
  ERRORS=$((ERRORS + 1))
fi

# 2. Check server.json version matches package.json version
PKG_VERSION=$(node -p "require('./package.json').version")
SERVER_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('./server.json','utf8')).version" 2>/dev/null || echo "MISSING")

if [ "$PKG_VERSION" != "$SERVER_VERSION" ]; then
  echo "❌ Version mismatch: package.json=$PKG_VERSION, server.json=$SERVER_VERSION" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✅ Version match: $PKG_VERSION"
fi

# 3. Validate server.json via mcp-publisher (if installed)
if command -v mcp-publisher &>/dev/null; then
  if mcp-publisher validate 2>&1; then
    echo "✅ server.json validates against MCP registry schema"
  else
    echo "❌ server.json failed mcp-publisher validate" >&2
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "⚠️  mcp-publisher not installed, skipping schema validation"
fi

# 4. Check for uncommitted changes
if git rev-parse --is-inside-work-tree &>/dev/null; then
  DIRTY=$(git status --porcelain 2>/dev/null || true)
  if [ -n "$DIRTY" ]; then
    echo "❌ Working tree has uncommitted changes:" >&2
    echo "$DIRTY" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Working tree is clean"
  fi
else
  echo "⚠️  Not a git repo, skipping dirty check"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "❌ Pre-publish check failed with $ERRORS error(s). Aborting." >&2
  exit 1
fi

echo ""
echo "✅ All pre-publish checks passed. Proceeding with publish."
