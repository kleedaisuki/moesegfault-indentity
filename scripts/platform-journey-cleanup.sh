#!/usr/bin/env bash
# Leave only the inert named callback required by the staging service binding.
set -euo pipefail

npx --no-install wrangler secret delete JOURNEY_TOKEN --env '' --config wrangler.platform-journey-bootstrap.jsonc || true
npx --no-install wrangler deploy --env '' --config wrangler.platform-journey-bootstrap.jsonc
