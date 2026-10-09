export const serviceIds = ["hosting", "auth", "billing"] as const;
export type ServiceId = typeof serviceIds[number];
export type ProbeState = "reachable" | "degraded" | "unavailable" | "unknown";
export type Probe = { id: ServiceId; state: ProbeState; checkedAt: string; latencyMs: number | null; httpStatus: number | null };
export type StatusReport = { schemaVersion: 1; scope: "public-transport"; checkedAt: string; staleAfterSeconds: number; services: Probe[] };

export const serviceDetails: Record<ServiceId, { name: string; description: string }> = {
  hosting: { name: "Website", description: "The public homepage returns the expected Grainform page." },
  auth: { name: "Sign-in service", description: "The public authentication configuration responds for Grainform." },
  billing: { name: "Billing service", description: "The billing endpoint responds and rejects an unsigned request." },
};

export function responseState(matches: boolean, latencyMs: number, slowAfterMs = 5000): ProbeState {
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(slowAfterMs) || slowAfterMs < 1) throw new Error("Invalid timing.");
  return !matches ? "unavailable" : latencyMs > slowAfterMs ? "degraded" : "reachable";
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Accept only the small public payload. Raw HTTP bodies and exception messages never enter the UI.
export function parseStatusReport(input: unknown): StatusReport {
  if (!input || typeof input !== "object") throw new Error("Invalid report.");
  const report = input as Record<string, unknown>;
  if (report.schemaVersion !== 1 || report.scope !== "public-transport" || !isoDate(report.checkedAt)
    || typeof report.staleAfterSeconds !== "number" || !Number.isInteger(report.staleAfterSeconds)
    || report.staleAfterSeconds < 60 || report.staleAfterSeconds > 7200
    || !Array.isArray(report.services) || report.services.length !== serviceIds.length) throw new Error("Invalid report.");
  const seen = new Set<string>();
  const services = report.services.map((value: unknown): Probe => {
    if (!value || typeof value !== "object") throw new Error("Invalid service.");
    const p = value as Record<string, unknown>;
    if (typeof p.id !== "string" || !serviceIds.includes(p.id as ServiceId) || seen.has(p.id)
      || !["reachable", "degraded", "unavailable", "unknown"].includes(p.state as string)
      || !isoDate(p.checkedAt) || Date.parse(p.checkedAt) > Date.parse(report.checkedAt as string)
      || Date.parse(report.checkedAt as string) - Date.parse(p.checkedAt) > 120000
      || !(p.latencyMs === null || typeof p.latencyMs === "number" && Number.isInteger(p.latencyMs) && p.latencyMs >= 0 && p.latencyMs <= 120000)
      || !(p.httpStatus === null || typeof p.httpStatus === "number" && Number.isInteger(p.httpStatus) && p.httpStatus >= 100 && p.httpStatus <= 599)
      || (["reachable", "degraded"].includes(p.state as string) && (p.latencyMs === null || p.httpStatus === null))) throw new Error("Invalid service.");
    seen.add(p.id);
    return { id: p.id as ServiceId, state: p.state as ProbeState, checkedAt: p.checkedAt, latencyMs: p.latencyMs as number | null, httpStatus: p.httpStatus as number | null };
  });
  return { schemaVersion: 1, scope: "public-transport", checkedAt: report.checkedAt, staleAfterSeconds: report.staleAfterSeconds, services };
}

export function reportFreshness(report: StatusReport, now = Date.now()): "fresh" | "stale" | "invalid" {
  if (!Number.isFinite(now)) return "invalid";
  const age = now - Date.parse(report.checkedAt);
  if (!Number.isFinite(age) || age < -300000) return "invalid";
  return age > report.staleAfterSeconds * 1000 ? "stale" : "fresh";
}

export function reportSummary(report: StatusReport, now = Date.now()): string {
  const freshness = reportFreshness(report, now);
  if (freshness === "invalid") return "Current status is unavailable.";
  if (freshness === "stale") return "These checks are out of date.";
  if (report.services.some(p => p.state === "unavailable")) return "One or more checks failed.";
  if (report.services.some(p => p.state === "unknown")) return "Some services could not be checked.";
  if (report.services.some(p => p.state === "degraded")) return "One or more services responded slowly.";
  return "The latest checks reached every endpoint.";
}
