import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatusReport, responseState } from "../src/status/model.ts";

const origin = "https://grainform.app";
const projectId = "grainform-app";
const billingURL = "https://us-central1-grainform-app.cloudfunctions.net/billingAccess";
const timeoutMs = 12000;
const maxBodyBytes = 1024 * 1024;

export async function readBounded(response) {
  if (Number(response.headers.get("content-length")) > maxBodyBytes) throw new Error("Oversized response.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) throw new Error("Oversized response.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}

// The probe's expected rejection is intentional. It cannot create customers, sessions or payments.
export function expectedBillingResponse(response, body) {
  if (response.status !== 401 || !response.headers.get("content-type")?.includes("application/json")) return false;
  try { return JSON.parse(body)?.error?.status === "UNAUTHENTICATED"; } catch { return false; }
}

export function expectedHomepage(response, body) {
  return response.status === 200 && !!response.headers.get("content-type")?.includes("text/html")
    && /<title>[^<]*Grainform/i.test(body)
    && /<link\b[^>]*rel=["']canonical["'][^>]*href=["']https:\/\/grainform\.app\/["']/i.test(body);
}

export function expectedAuth(response, body, projectNumber) {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) return false;
  try {
    const data = JSON.parse(body);
    return data.projectId === projectNumber && Array.isArray(data.authorizedDomains)
      && data.authorizedDomains.includes("grainform.app");
  } catch { return false; }
}

async function request(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json,text/html;q=0.9", "user-agent": "GrainformStatus/1.0", ...options.headers } });
  return { response, body: await readBounded(response) };
}

async function probe(id, work) {
  const start = performance.now();
  try {
    const { response, matches } = await work();
    const latencyMs = Math.round(performance.now() - start);
    return { id, checkedAt: new Date().toISOString(), latencyMs, httpStatus: response.status, state: responseState(matches, latencyMs) };
  } catch {
    // Never publish raw errors, URLs with API keys, response text, or runner details.
    return { id, checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - start), httpStatus: null, state: "unavailable" };
  }
}

export async function runChecks(fetcher = fetch) {
  const config = request(fetcher, origin + "/__/firebase/init.json").then(({ response, body }) => {
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Public configuration unavailable.");
    const data = JSON.parse(body);
    if (data.projectId !== projectId || typeof data.apiKey !== "string" || !/^AIza[\w-]{35}$/.test(data.apiKey)
      || typeof data.appId !== "string" || !/^1:\d+:web:[a-z0-9]+$/.test(data.appId)) throw new Error("Unexpected public configuration.");
    return { apiKey: data.apiKey, projectNumber: data.appId.split(":")[1] };
  }).catch(() => null);
  const services = await Promise.all([
    probe("hosting", async () => {
      const { response, body } = await request(fetcher, origin + "/");
      return { response, matches: expectedHomepage(response, body) };
    }),
    (async () => {
      const publicConfig = await config;
      if (!publicConfig) return { id: "auth", checkedAt: new Date().toISOString(), state: "unknown", latencyMs: null, httpStatus: null };
      return probe("auth", async () => {
        const { response, body } = await request(fetcher, "https://identitytoolkit.googleapis.com/v1/projects?key=" + encodeURIComponent(publicConfig.apiKey));
        return { response, matches: expectedAuth(response, body, publicConfig.projectNumber) };
      });
    })(),
    probe("billing", async () => {
      const { response, body } = await request(fetcher, billingURL, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: {} }),
      });
      return { response, matches: expectedBillingResponse(response, body) };
    }),
  ]);
  return parseStatusReport({ schemaVersion: 1, scope: "public-transport", checkedAt: new Date().toISOString(), staleAfterSeconds: 7200, services });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("Usage: node --experimental-strip-types scripts/status-check.mjs [--output path/status.json]");
  const report = await runChecks();
  const json = JSON.stringify(report, null, 2) + "\n";
  if (args[1]) {
    const output = resolve(args[1]), temporary = output + ".tmp";
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, json, "utf8");
    await rename(temporary, output);
  } else process.stdout.write(json);
  // Always publish the result first, then fail the monitoring job on a failed or incomplete check.
  if (report.services.some(s => s.state !== "reachable")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Status check could not produce a valid report."); process.exitCode = 1; });
}
