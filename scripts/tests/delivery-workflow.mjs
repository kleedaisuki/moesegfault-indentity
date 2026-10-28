/**
 * Hosted, provider-free contract tests for delivery event filtering.
 * The intentionally narrow header recognizer rejects syntax changes instead of
 * pretending to parse arbitrary YAML. GitHub remains the workflow interpreter.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
