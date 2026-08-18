#!/usr/bin/env bash
set -euo pipefail

script="scripts/deploy.sh"

test -x "$script"
grep -Fq 'REMOTE="${DEPLOY_REMOTE:?set DEPLOY_REMOTE, e.g. user@example.com:/var/www/blog/}"' "$script"
grep -Fq 'npm run build' "$script"
grep -Fq 'rsync -az --delete -e ssh public/ "$REMOTE"' "$script"
