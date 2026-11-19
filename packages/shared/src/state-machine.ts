export type Status = "unknown" | "up" | "degraded" | "down";

export interface MonitorState {
  status: Status;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  consecutiveSlow: number;
  consecutiveFast: number;
  lastCheckedAt: number | null; // ms
}

export interface StateConfig {
  failThreshold: number;
  recoverThreshold: number;
  degradedLatencyMs: number | null;
  degradedThreshold?: number;
}

export interface CheckInput {
  atMs: number;
  ok: boolean;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface StateEvent {
  type: "incident_opened" | "degraded" | "recovered";
  atMs: number;
  cause: string | null;
}

export const DEFAULT_DEGRADED_THRESHOLD = 3;

export const INITIAL_STATE: MonitorState = {
  status: "unknown",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  consecutiveSlow: 0,
  consecutiveFast: 0,
  lastCheckedAt: null,
};

export function evaluate(
  prev: MonitorState,
  check: CheckInput,
  cfg: StateConfig
): { state: MonitorState; events: StateEvent[]; ignored: boolean } {
  // 1. If prev.lastCheckedAt !== null and check.atMs <= prev.lastCheckedAt: return {state: prev, events: [], ignored: true}.
  if (prev.lastCheckedAt !== null && check.atMs <= prev.lastCheckedAt) {
    return { state: prev, events: [], ignored: true };
  }

  // 2. slow = check.ok && degradedLatencyMs !== null && latencyMs !== null && latencyMs > degradedLatencyMs.
  const slow =
    check.ok &&
    cfg.degradedLatencyMs !== null &&
    check.latencyMs !== null &&
    check.latencyMs > cfg.degradedLatencyMs;

  // 3. Counters:
  const failures = check.ok ? 0 : prev.consecutiveFailures + 1;
  const successes = check.ok ? prev.consecutiveSuccesses + 1 : 0;
  const consecutiveSlow = slow ? prev.consecutiveSlow + 1 : 0;
  const consecutiveFast = check.ok && !slow ? prev.consecutiveFast + 1 : 0;
  const lastCheckedAt = check.atMs;

  // 4. State transitions:
  const degradedThreshold = cfg.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD;
  let status = prev.status;
  const events: StateEvent[] = [];

  if (failures >= cfg.failThreshold && status !== "down") {
    events.push({
      type: "incident_opened",
      atMs: check.atMs,
      cause: check.errorCode ?? null,
    });
    status = "down";
  } else if (status === "down") {
    if (successes >= cfg.recoverThreshold) {
      events.push({
        type: "recovered",
        atMs: check.atMs,
        cause: null,
      });
      status = "up";
    }
  } else {
    if (status === "unknown" && check.ok) {
      status = "up";
    }
    if (status === "up" && consecutiveSlow >= degradedThreshold) {
      events.push({
        type: "degraded",
        atMs: check.atMs,
        cause: null,
      });
      status = "degraded";
    } else if (status === "degraded" && consecutiveFast >= cfg.recoverThreshold) {
      events.push({
        type: "recovered",
        atMs: check.atMs,
        cause: null,
      });
      status = "up";
    }
  }

  return {
    state: {
      status,
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
      consecutiveSlow,
      consecutiveFast,
      lastCheckedAt,
    },
    events,
    ignored: false,
  };
}
