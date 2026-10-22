#!/usr/bin/env bash
# Installs a pinned n8n into test/.runtime for the end-to-end test.
# Uses its own npm cache, so it never fights other npm runs over ~/.npm.
set -euo pipefail

N8N_VERSION="${N8N_VERSION:-2.41.7}"
here="$(cd "$(dirname "$0")" && pwd)"
runtime="$here/.runtime"
mkdir -p "$runtime"
cd "$runtime"
[ -f package.json ] || echo '{"private":true}' > package.json

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "n8n $N8N_VERSION needs Node 24 or newer (this is Node $major)." >&2
  exit 1
fi

if [ "$major" -ge 25 ]; then
  # isolated-vm (n8n's default expression sandbox) has no build for Node 25
  # yet, so skip native builds and build only sqlite3. e2e.mjs then runs n8n
  # with N8N_EXPRESSION_ENGINE=legacy.
  npm install --no-audit --no-fund --loglevel=error --ignore-scripts --cache "$runtime/.npm-cache" "n8n@$N8N_VERSION"
  npm rebuild --cache "$runtime/.npm-cache" sqlite3
else
  npm install --no-audit --no-fund --loglevel=error --cache "$runtime/.npm-cache" "n8n@$N8N_VERSION"
fi

# The download cache is only needed during the install (it is ~1.2 GB).
rm -rf "$runtime/.npm-cache"
echo "n8n $("$runtime/node_modules/.bin/n8n" --version) installed in $runtime"
