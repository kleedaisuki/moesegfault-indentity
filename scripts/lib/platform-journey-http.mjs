export function safeSnippet(value) {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\/d\/[A-Za-z0-9_-]+/g, "/d/[capability]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[recipient]")
    .replace(/\b[A-Za-z0-9_-]{43,}\b/g, "[token]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 320);
}

function responseDiagnostic(response, operation, body) {
  return JSON.stringify({operation, status: response.status,
    content_type: response.headers.get("content-type") ?? "missing",
    cf_ray: response.headers.get("cf-ray") ?? undefined,
    correlation_id: response.headers.get("x-moesegfault-correlation-id") ?? undefined,
    body: safeSnippet(body) || "[empty]"});
}

export async function readJson(response, operation, expectedStatus = 200) {
  const text = await response.text();
  const diagnostic = responseDiagnostic(response, operation, text);
  if (response.status !== expectedStatus) throw new Error(`Unexpected HTTP response: ${diagnostic}`);
  if (!/^application\/(?:problem\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error(`Expected JSON response: ${diagnostic}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Malformed JSON response: ${diagnostic}`); }
}

export async function waitFixtureReady(origin, headers, {fetcher = fetch, attempts = 30, intervalMs = 2000, timeoutMs = 5000, report = console.log} = {}) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(`${origin}/status/00000000-0000-0000-0000-000000000000`, {headers, signal: AbortSignal.timeout(timeoutMs)});
      const status = await readJson(response, "fixture authenticated readiness");
      if (status.received !== false || status.decision?.status !== 404) throw new Error(`Fixture bindings not ready: ${JSON.stringify({received: status.received, decision_status: status.decision?.status})}`);
      report(`Fixture authenticated readiness passed (attempt ${attempt}).`);
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt === 1) report(`Waiting for fixture deployment and secret propagation: ${safeSnippet(error instanceof Error ? error.message : String(error))}`);
      if (attempt < attempts) await new Promise(done => setTimeout(done, intervalMs));
    }
  }
  throw new Error(`Fixture readiness failed after ${attempts} read-only probes. No POST /start was attempted. ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`);
}
