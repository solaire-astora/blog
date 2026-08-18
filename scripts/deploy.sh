#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE="${DEPLOY_REMOTE:?set DEPLOY_REMOTE, e.g. user@example.com:/var/www/blog/}"

test -f package.json
npm run build
rsync -az --delete -e ssh public/ "$REMOTE"

echo "deployed to $REMOTE"
