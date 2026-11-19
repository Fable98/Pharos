export interface AlertPayload {
  event: "incident_opened" | "degraded" | "recovered" | "test";
  at: string;
  cause: string | null;
  monitor: {
    id: string;
    name: string;
    url: string;
  } | null;
  incident: {
    id: string;
    startedAt: string;
    resolvedAt: string | null;
    durationS: number | null;
  } | null;
}
