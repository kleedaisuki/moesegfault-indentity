#!/usr/bin/env bash
# Read bounded staging-only delivery metadata without trusting the fixture API.
set -euo pipefail

echo '::group::Staging Notifications delivery state'
npx --no-install wrangler d1 execute moesegfault-notifications-staging --remote --env '' --config wrangler.notifications.jsonc --json --command="SELECT message_id,sender,state,attempt_count,last_error_code,provider_message_id,correlation_id,created_at FROM notification_messages WHERE service='journey' ORDER BY created_at DESC,message_id DESC LIMIT 10" || echo '::warning::Staging Notifications delivery metadata query failed'
echo '::endgroup::'
echo '::group::Staging Decisions delivery state'
npx --no-install wrangler d1 execute moesegfault-decisions-staging --remote --env '' --config wrangler.decisions.jsonc --json --command="SELECT o.decision_id,o.kind,o.state,o.attempts,o.last_error_code FROM decision_outbox o JOIN decisions d ON d.decision_id=o.decision_id WHERE d.service='journey' ORDER BY o.created_at DESC,o.outbox_id DESC LIMIT 10" || echo '::warning::Staging Decisions delivery metadata query failed'
echo '::endgroup::'
