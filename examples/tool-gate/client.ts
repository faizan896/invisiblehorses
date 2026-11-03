/**
 * Agent-side example. Owner credentials and provider secrets never belong here.
 * Run after creating an agent and a job using docs/company-pilot.md.
 */
const base = process.env.TOOL_GATE_URL ?? "http://127.0.0.1:8410";
const origin = new URL(base);
if (
  origin.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
)
  throw new Error("Remote tool gates require HTTPS");
const key = process.env.TOOL_GATE_AGENT_KEY;
const job = process.env.TOOL_GATE_JOB_ID;
if (!key || !job)
  throw new Error("Set TOOL_GATE_AGENT_KEY and TOOL_GATE_JOB_ID");
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
const response = await fetch(new URL("/v1/requests", base), {
  method: "POST",
  headers,
  signal: AbortSignal.timeout(15000),
  body: JSON.stringify({
    job_id: job,
    tool_id: process.env.TOOL_GATE_TOOL_ID ?? "data-search",
    input: { query: "renewable energy suppliers" },
    idempotency_key:
      process.env.TOOL_GATE_REQUEST_KEY ?? "research-job-001-search-001",
  }),
});
if (!response.ok)
  throw new Error(
    `Request failed with HTTP ${response.status}; retry the same logical request and idempotency key`,
  );
const request = (await response.json()) as { id: string; status: string };
console.log(JSON.stringify(request, null, 2));
console.log(
  "Read /v1/requests/" +
    request.id +
    " with the same agent key. A pending approval is not a completed purchase.",
);
export {};
