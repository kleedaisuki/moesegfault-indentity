/**
 * Hosted, provider-free contract tests for delivery event filtering.
 * The intentionally narrow header recognizer rejects syntax changes instead of
 * pretending to parse arbitrary YAML. GitHub remains the workflow interpreter.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const journeyDiagnostics = readFileSync(new URL('../platform-journey-diagnostics.sh', import.meta.url), 'utf8');
const journeyCleanup = readFileSync(new URL('../platform-journey-cleanup.sh', import.meta.url), 'utf8');
const ignoredPaths = [
  "docs/**/*.md",
  "skills/**/*.md",
  "skills/**/agents/*.yaml",
  "README.md",
  "AGENTS.md",
  "infra/RUNBOOK.md",
];

/** Recognize only this contract's exact-path and recursive-directory patterns. */
function matchesIgnoredPath(path, pattern) {
  if (!pattern.includes("**")) return path === pattern;
  const [prefix, suffix] = pattern.split("**");
  if (!path.startsWith(prefix)) return false;
  const tail = path.slice(prefix.length);
  if (suffix === "/*.md") return tail.endsWith(".md");
  if (suffix === "/agents/*.yaml") return /^(?:.*\/)?agents\/[^/]+\.yaml$/.test(tail);
  throw new Error(`Unsupported contract pattern: ${pattern}`);
}

/** Model native paths-ignore semantics, not job success or provider deployment. */
function eventRuns(event, paths = [], branch = "main") {
  if (event === "pull_request" || event === "workflow_dispatch") return true;
  return event === "push" && branch === "main"
    && paths.some((path) => !ignoredPaths.some((pattern) => matchesIgnoredPath(path, pattern)));
}

test("PR checks and explicit dispatch remain unfiltered; only main push has a narrow allowlist", () => {
  const header = workflow.split("\npermissions:\n")[0];
  assert.match(header, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n/m);
  const push = header.match(/  push:\n([\s\S]*?)  workflow_dispatch:/)?.[1];
  assert.ok(push);
  assert.deepEqual([...push.matchAll(/^      - '([^']+)'$/gm)].map((match) => match[1]), ignoredPaths);
  assert.match(push, /^    paths-ignore:$/m);
  assert.doesNotMatch(push, /^    paths:$/m);
  assert.match(header, /default: verify-only/);
  assert.match(header, /options: \[verify-only, staging-only\]/);
  assert.ok(workflow.includes("run: node --test scripts/tests/delivery-workflow.mjs"));
});

test("documentation and Skill-only main pushes do not enter automatic delivery", () => {
  for (const paths of [
    ["README.md"],
    ["docs/configuration.md", "docs/research/nested/evidence.md", "infra/RUNBOOK.md"],
    ["skills/moesegfault-identity/SKILL.md", "skills/moesegfault-identity/references/oidc-integration.md"],
    ["skills/moesegfault-identity/agents/openai.yaml", "AGENTS.md"],
  ]) {
    assert.equal(eventRuns("push", paths), false);
    assert.equal(eventRuns("pull_request", paths), true);
    assert.equal(eventRuns("workflow_dispatch", paths), true);
  }
});

test("runtime, unknown extensions, migrations, workflows and mixed changes still run", () => {
  for (const path of [
    "crates/identity-worker/src/lib.rs", "apps/login/src/main.tsx",
    "migrations/0010_add_contact.sql", "wrangler.identity.jsonc", "Cargo.lock",
    "package-lock.json", "scripts/release.sh", ".github/workflows/ci.yml",
    "docs/runtime.json", "skills/moesegfault-identity/tool.mjs",
    "apps/login/README.md", "docs/configuration.MD",
  ]) {
    assert.equal(eventRuns("push", [path]), true, path);
    assert.equal(eventRuns("push", ["docs/configuration.md", path]), true, path);
    assert.equal(eventRuns("push", [path], "feature"), false, path);
  }
});

test("deployment still requires tested package and staging; PR and manual production remain forbidden", () => {
  const staging = workflow.match(/\n  deploy-staging:\n([\s\S]*?)\n  deploy-production:/)?.[1];
  const production = workflow.match(/\n  deploy-production:\n([\s\S]*?)\n  quality-gate:/)?.[1];
  assert.ok(staging);
  assert.ok(production);
  assert.match(staging, /if: \(github.event_name == 'push' && github.ref == 'refs\/heads\/main'\) \|\| \(github.event_name == 'workflow_dispatch' && inputs.delivery == 'staging-only'\)/);
  assert.match(staging, /needs: package/);
  assert.match(production, /if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(production, /needs: deploy-staging/);
  assert.ok(production.includes('test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$GITHUB_SHA"'));
  assert.match(workflow, /quality-gate:\n[\s\S]*?if: always\(\)\n    needs: \[rust, frontend, platform, contracts, package\]/);
});

test('five-unit delivery keeps private services inaccessible and promotes bundled platform code', () => {
  assert.match(workflow, /needs: \[rust, frontend, platform, contracts\]/);
  assert.match(workflow, /npm run typecheck:platform/);
  assert.match(workflow, /npm run test:platform/);
  assert.match(workflow, /dist\/platform/);
  const release = readFileSync(new URL('../release.sh', import.meta.url), 'utf8');
  assert.match(release, /node scripts\/provision-platform\.mjs "\$TARGET"/);
  assert.match(release, /for unit in notifications decisions/);
  assert.match(release, /dist\/platform\/notifications\/index\.js --no-bundle/);
  assert.match(release, /dist\/platform\/decisions\/index\.js --no-bundle/);
  assert.ok(release.indexOf('for unit in notifications decisions') < release.indexOf('deploy_unit "$IDENTITY_CONFIG"'));
  assert.match(release, /if ! jq -e 'any\(\.\[\]; \.name == "OUTBOX_KEY"\)'/);
});

test('validated-result caches require exact complete-input keys; deployment package remains checksummed', () => {
  for (const id of ['identity-build', 'frontend-build', 'identity-integration']) {
    const block = workflow.match(new RegExp(`id: ${id}\\n([\\s\\S]*?)(?=      - name:|      - uses:)`))?.[1];
    assert.ok(block, id);
    assert.match(block, /hashFiles\(/);
    assert.match(block, /\.github\/workflows\/ci\.yml/);
    assert.doesNotMatch(block, /restore-keys:/);
    assert.ok(workflow.includes(`steps.${id}.outputs.cache-hit != 'true'`));
  }
  assert.match(workflow, /sha256sum --check release-\$\{GITHUB_SHA\}\.sha256/);
});

test('dynamic Rust advisories remain fresh on validated source-cache hits', () => {
  const cargoCache = workflow.match(/      - name: Restore Cargo data[^\n]*\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(cargoCache);
  assert.doesNotMatch(cargoCache, /if:/);
  for (const name of ['Install pinned advisory checker', 'Check current Rust advisories']) {
    const step = workflow.match(new RegExp(`      - name: ${name}\\n([\\s\\S]*?)(?=      - name:)`))?.[1];
    assert.ok(step, name);
    assert.doesNotMatch(step, /if:/);
  }
  assert.match(workflow, /run: cargo deny --locked check advisories/);
  assert.match(workflow, /cargo deny --locked check bans licenses sources/);
  assert.match(workflow, /npm run typecheck --workspace=@moesegfault\/\$\{\{ matrix\.app \}\}/);
  assert.doesNotMatch(workflow, /npm run lint --workspace=@moesegfault\/\$\{\{ matrix\.app \}\}/);
});

test('dependency caches survive failed gates without certifying failed build artifacts', () => {
  for (const id of ['cargo-tools', 'cargo-data']) {
    const restore = workflow.match(new RegExp(`id: ${id}\\n([\\s\\S]*?)(?=      - name:)`))?.[1];
    assert.ok(restore, id);
    assert.match(restore, /uses: actions\/cache\/restore@/);
    const save = workflow.match(new RegExp(`if: always\\(\\) && steps\\.${id}\\.outcome == 'success' && steps\\.${id}\\.outputs\\.cache-hit != 'true'[^\\n]*\\n([\\s\\S]*?)(?=      - name:)`))?.[1];
    assert.ok(save, id);
    assert.match(save, /uses: actions\/cache\/save@/);
    assert.ok(save.includes(`key: \${{ steps.${id}.outputs.cache-primary-key }}`));
    if (id === 'cargo-tools') assert.doesNotMatch(restore, /Cargo\.lock|restore-keys:/);
    else assert.match(restore, /restore-keys:/);
  }
  const validatedBuild = workflow.match(/id: identity-build\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(validatedBuild);
  assert.match(validatedBuild, /uses: actions\/cache@/);
  assert.doesNotMatch(validatedBuild, /always\(\)|actions\/cache\/save@/);
  const toolSaveCondition = workflow.match(/- name: Save pinned Cargo tools[^\n]*\n        if: ([^\n]+)/)?.[1];
  assert.ok(toolSaveCondition);
  for (const id of ['cargo-advisory-tool', 'cargo-build-tool']) {
    assert.ok(toolSaveCondition.includes(`steps.${id}.outcome == 'success'`));
  }
  assert.ok(workflow.indexOf('id: cargo-build-tool') < workflow.indexOf('- name: Check current Rust advisories'));
});

test('optional platform journey is dispatch-only staging and always restores the inert fixture', () => {
  const header = workflow.split('\npermissions:\n')[0];
  assert.match(header, /platform_journey:\n[\s\S]*?default: skip\n        options: \[skip, http, mailbox\]/);
  const staging = workflow.match(/\n  deploy-staging:\n([\s\S]*?)\n  deploy-production:/)?.[1];
  const production = workflow.match(/\n  deploy-production:\n([\s\S]*?)\n  quality-gate:/)?.[1];
  assert.ok(staging);
  assert.ok(production);
  assert.match(staging, /concurrency: \{group: cloudflare-staging, cancel-in-progress: false\}/);
  const journey = staging.match(/id: platform-journey\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(journey);
  assert.match(journey, /if: github.event_name == 'workflow_dispatch' && inputs.delivery == 'staging-only' && inputs.platform_journey != 'skip'/);
  assert.match(journey, /PLATFORM_JOURNEY_MODE: \$\{\{ inputs.platform_journey \}\}/);
  assert.match(journey, /PLATFORM_JOURNEY_RECIPIENT: \$\{\{ secrets.PLATFORM_JOURNEY_RECIPIENT \}\}/);
  assert.match(journey, /run: node scripts\/platform-journey\.mjs/);
  assert.ok(staging.indexOf('scripts/release.sh staging') < staging.indexOf('id: platform-journey'));
  assert.match(staging, /if: always\(\) && steps.platform-journey.outcome != 'skipped'/);
  assert.match(staging, /run: bash scripts\/platform-journey-cleanup\.sh/);
  assert.match(journeyCleanup, /secret delete JOURNEY_TOKEN --env '' --config wrangler\.platform-journey-bootstrap\.jsonc \|\| true/);
  assert.match(journeyCleanup, /wrangler deploy --env '' --config wrangler\.platform-journey-bootstrap\.jsonc/);
  assert.doesNotMatch(production, /platform-journey|PLATFORM_JOURNEY_RECIPIENT/);
});

test('failed manual staging journeys expose bounded delivery metadata independently of the fixture', () => {
  const diagnostics = workflow.match(/- name: Diagnose failed staging journey delivery without the fixture API\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(diagnostics);
  assert.match(diagnostics, /if: always\(\) && steps.platform-journey.outcome == 'failure' && github.event_name == 'workflow_dispatch' && inputs.delivery == 'staging-only' && inputs.platform_journey != 'skip'/);
  assert.match(diagnostics, /continue-on-error: true/);
  assert.match(diagnostics, /timeout-minutes: 1/);
  assert.match(diagnostics, /run: bash scripts\/platform-journey-diagnostics\.sh/);
  assert.match(journeyDiagnostics, /moesegfault-notifications-staging --remote --env '' --config wrangler\.notifications\.jsonc/);
  assert.match(journeyDiagnostics, /moesegfault-decisions-staging --remote --env '' --config wrangler\.decisions\.jsonc/);
  const queries = [...journeyDiagnostics.matchAll(/--command="([^"]+)"/g)].map(match => match[1]);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^SELECT message_id,sender,state,attempt_count,last_error_code,provider_message_id,correlation_id,created_at FROM notification_messages WHERE service='journey' ORDER BY created_at DESC,message_id DESC LIMIT 10$/);
  assert.match(queries[1], /^SELECT o\.decision_id,o\.kind,o\.state,o\.attempts,o\.last_error_code FROM decision_outbox o JOIN decisions d ON d\.decision_id=o\.decision_id WHERE d\.service='journey' ORDER BY o\.created_at DESC,o\.outbox_id DESC LIMIT 10$/);
  assert.doesNotMatch(journeyDiagnostics, /\b(payload|payload_hash|recipient|token_digest|request_digest|idempotency_key|JOURNEY_TOKEN)\b/);
  assert.ok(workflow.indexOf('Diagnose failed staging journey') < workflow.indexOf('Restore the inert staging fixture after the requested journey'));
});

test('bootstrap offers an explicit staging acceptance fast path without infrastructure or app deployment', () => {
  const bootstrap = readFileSync(new URL('../../.github/workflows/bootstrap.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bootstrap, /platform_journey:\n[\s\S]*?default: skip\n        options: \[skip, http, mailbox\]/);
  assert.match(bootstrap, /if: inputs.platform_journey == 'skip' \|\| inputs.target == 'staging'/);
  assert.match(bootstrap, /concurrency: \{group: 'cloudflare-\$\{\{ inputs.target \}\}', cancel-in-progress: false\}/);
  assert.match(bootstrap, /if: inputs.platform_journey == 'skip'\n        run: scripts\/bootstrap-cloudflare\.sh/);
  assert.match(bootstrap, /node --test scripts\/tests\/platform-journey-http\.mjs\n          node scripts\/tests\/platform-journey\.mjs/);
  const journey = bootstrap.match(/id: platform-journey\n([\s\S]*?)(?=      - name:)/)?.[1];
  assert.ok(journey);
  assert.match(journey, /if: inputs.target == 'staging' && inputs.platform_journey != 'skip'/);
  assert.match(journey, /PLATFORM_JOURNEY_RECIPIENT: \$\{\{ secrets.PLATFORM_JOURNEY_RECIPIENT \}\}/);
  assert.match(journey, /PLATFORM_JOURNEY_MODE: \$\{\{ inputs.platform_journey \}\}/);
  assert.match(journey, /run: node scripts\/platform-journey\.mjs/);
  assert.match(bootstrap, /if: always\(\) && steps.platform-journey.outcome == 'failure' && inputs.target == 'staging'/);
  assert.match(bootstrap, /run: bash scripts\/platform-journey-diagnostics\.sh/);
  assert.match(bootstrap, /if: always\(\) && steps.platform-journey.outcome != 'skipped' && inputs.target == 'staging'/);
  assert.match(bootstrap, /run: bash scripts\/platform-journey-cleanup\.sh/);
  assert.doesNotMatch(bootstrap, /scripts\/release\.sh|npm run build|worker-build|cargo test|wrangler deploy/);
  const standalone = readFileSync(new URL('../../.github/workflows/platform-journey.yml', import.meta.url), 'utf8');
  assert.match(standalone, /run: bash scripts\/platform-journey-cleanup\.sh/);
});

test('disabling the staging public driver preserves its private callback state and decision deadline', () => {
  const bootstrap = JSON.parse(readFileSync(new URL('../../wrangler.platform-journey-bootstrap.jsonc', import.meta.url), 'utf8'));
  const decisions = JSON.parse(readFileSync(new URL('../../wrangler.decisions.jsonc', import.meta.url), 'utf8'));
  assert.equal(bootstrap.name, 'moesegfault-platform-journey-staging');
  assert.equal(bootstrap.d1_databases.length, 1);
  assert.deepEqual(bootstrap.d1_databases[0], {
    binding: 'DB',
    database_name: decisions.d1_databases[0].database_name,
    database_id: decisions.d1_databases[0].database_id,
  });
  assert.equal(bootstrap.services, undefined);
  assert.equal(bootstrap.vars, undefined);
  assert.equal(bootstrap.send_email, undefined);
  const fixture = readFileSync(new URL('../../apps/platform-journey/src/index.ts', import.meta.url), 'utf8');
  const decisionRequest = fixture.match(/title: "欢迎来到 moeSegFault 决策中心"([\s\S]*?)context: \{test_run: run_id\}/)?.[1];
  assert.ok(decisionRequest);
  assert.doesNotMatch(decisionRequest, /expires_at/);
  assert.doesNotMatch(fixture, /DELETE FROM platform_journey_callbacks/);
  const driver = readFileSync(new URL('../platform-journey.mjs', import.meta.url), 'utf8');
  assert.match(driver, /observation window ended/);
  assert.match(driver, /business deadline is unchanged/);
  assert.match(driver, /private callback consumer remains available/);
});
