#!/usr/bin/env bash
# Disable the public driver while retaining DB-backed private callbacks for late replies.
set -euo pipefail

npx --no-install wrangler secret delete JOURNEY_TOKEN --env '' --config wrangler.platform-journey-bootstrap.jsonc || true
npx --no-install wrangler deploy --env '' --config wrangler.platform-journey-bootstrap.jsonc
