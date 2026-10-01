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
  assert.match(workflow, /quality-gate:\n[\s\S]*?if: always\(\)\n    needs: \[rust, frontend, contracts, package\]/);
});
