import { describe, it, expect } from "vitest";
import {
  evaluate,
  INITIAL_STATE,
  MonitorState,
  StateConfig,
  StateEvent,
} from "./state-machine";

describe("state machine", () => {
  const defaultConfig: StateConfig = {
    failThreshold: 3,
    recoverThreshold: 2,
    degradedLatencyMs: 1000,
    degradedThreshold: 3,
  };

  const cases: Array<[string, "up" | "down" | "degraded", string[]]> = [
    ["....", "up", []],
    ["..F.", "up", []],
    ["..FF.", "up", []],
    ["..FFF", "down", ["incident_opened"]],
    ["..FFFFF", "down", ["incident_opened"]],
    ["FFF.", "down", ["incident_opened"]],
    ["FFF..", "up", ["incident_opened", "recovered"]],
    ["FFF.F.", "down", ["incident_opened"]],
    ["FFF", "down", ["incident_opened"]],
    ["F.F.F.F.", "up", []],
    ["...SSS", "degraded", ["degraded"]],
    ["...SS.", "up", []],
    ["SSS..", "up", ["degraded", "recovered"]],
    ["SSS.", "degraded", ["degraded"]],
    ["SSSFFF", "down", ["degraded", "incident_opened"]],
  ];

  for (const [sequence, expectedStatus, expectedEventTypes] of cases) {
    it(`handles sequence "${sequence}" -> ${expectedStatus} with events ${JSON.stringify(expectedEventTypes)}`, () => {
      let state: MonitorState = { ...INITIAL_STATE };
      const allEvents: StateEvent[] = [];

      for (let i = 0; i < sequence.length; i++) {
        const char = sequence[i];
        const atMs = (i + 1) * 1000;
        let ok = true;
        let latencyMs: number | null = 100;
        let errorCode: string | null = null;

        if (char === "F") {
          ok = false;
          latencyMs = null;
          errorCode = "error";
        } else if (char === "S") {
          ok = true;
          latencyMs = 3000;
        }

        const res = evaluate(state, { atMs, ok, latencyMs, errorCode }, defaultConfig);
        expect(res.ignored).toBe(false);
        state = res.state;
        allEvents.push(...res.events);
      }

      expect(state.status).toBe(expectedStatus);
      expect(allEvents.map((e) => e.type)).toEqual(expectedEventTypes);
    });
  }

  it("duplicate and older results are ignored (ignored true, state unchanged)", () => {
    let state: MonitorState = { ...INITIAL_STATE };
    const res1 = evaluate(
      state,
      { atMs: 1000, ok: true, latencyMs: 50, errorCode: null },
      defaultConfig
    );
    expect(res1.ignored).toBe(false);
    state = res1.state;

    // Same timestamp
    const resDuplicate = evaluate(
      state,
      { atMs: 1000, ok: false, latencyMs: null, errorCode: "refused" },
      defaultConfig
    );
    expect(resDuplicate.ignored).toBe(true);
    expect(resDuplicate.state).toBe(state);
    expect(resDuplicate.events).toEqual([]);

    // Older timestamp
    const resOlder = evaluate(
      state,
      { atMs: 500, ok: false, latencyMs: null, errorCode: "refused" },
      defaultConfig
    );
    expect(resOlder.ignored).toBe(true);
    expect(resOlder.state).toBe(state);
    expect(resOlder.events).toEqual([]);
  });

  it("incident cause is recorded", () => {
    let state: MonitorState = { ...INITIAL_STATE };
    state = evaluate(
      state,
      { atMs: 1000, ok: false, latencyMs: null, errorCode: "refused" },
      defaultConfig
    ).state;
    state = evaluate(
      state,
      { atMs: 2000, ok: false, latencyMs: null, errorCode: "refused" },
      defaultConfig
    ).state;
    const res = evaluate(
      state,
      { atMs: 3000, ok: false, latencyMs: null, errorCode: "refused" },
      defaultConfig
    );
    expect(res.events).toHaveLength(1);
    expect(res.events[0].type).toBe("incident_opened");
    expect(res.events[0].cause).toBe("refused");
  });

  it("failThreshold 1 goes down on one failure", () => {
    let state: MonitorState = { ...INITIAL_STATE };
    const res = evaluate(
      state,
      { atMs: 1000, ok: false, latencyMs: null, errorCode: "timeout" },
      { ...defaultConfig, failThreshold: 1 }
    );
    expect(res.state.status).toBe("down");
    expect(res.events).toHaveLength(1);
    expect(res.events[0].type).toBe("incident_opened");
    expect(res.events[0].cause).toBe("timeout");
  });

  it("degradedLatencyMs null never degrades", () => {
    let state: MonitorState = { ...INITIAL_STATE };
    const allEvents: StateEvent[] = [];
    const cfg: StateConfig = { ...defaultConfig, degradedLatencyMs: null };

    for (let i = 0; i < 5; i++) {
      const res = evaluate(
        state,
        { atMs: (i + 1) * 1000, ok: true, latencyMs: 50000, errorCode: null },
        cfg
      );
      state = res.state;
      allEvents.push(...res.events);
    }

    expect(state.status).toBe("up");
    expect(allEvents).toEqual([]);
  });
});
