import { describe, it, expect } from "vitest";
import { backoffMs, escapeHtml, formatDuration, sign, telegramText } from "./delivery";
import type { AlertPayload } from "@pharos/shared";

describe("delivery", () => {
  describe("sign", () => {
    it("is deterministic and sensitive to secret, timestamp and body and matches sha256 hex format", () => {
      const secret = "my-secret-key";
      const timestamp = 1700000000;
      const body = JSON.stringify({ event: "test" });

      const sig1 = sign(secret, timestamp, body);
      const sig2 = sign(secret, timestamp, body);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Sensitive to secret
      expect(sign("other-secret", timestamp, body)).not.toBe(sig1);
      // Sensitive to timestamp
      expect(sign(secret, timestamp + 1, body)).not.toBe(sig1);
      // Sensitive to body
      expect(sign(secret, timestamp, body + " ")).not.toBe(sig1);
    });
  });

  describe("backoffMs", () => {
    it("with random 0.5 gives 15000 (attempt 1), 60000 (attempt 3), capped 3600000 (attempt 20)", () => {
      const midRandom = () => 0.5;
      expect(backoffMs(1, 15, midRandom)).toBe(15000);
      expect(backoffMs(3, 15, midRandom)).toBe(60000);
      expect(backoffMs(20, 15, midRandom)).toBe(3600000);
    });

    it("has jitter bounds 24000..36000 for attempt 2", () => {
      const minRandom = () => 0;
      const maxRandom = () => 1;
      expect(backoffMs(2, 15, minRandom)).toBe(24000);
      expect(backoffMs(2, 15, maxRandom)).toBe(3600000 * 0 + 36000);
    });
  });

  describe("telegramText", () => {
    it("escapes HTML and shows 'Downtime: 1h 2m 5s' for 3725 s", () => {
      const payload: AlertPayload = {
        event: "recovered",
        at: "2026-11-19T12:00:00.000Z",
        cause: null,
        monitor: {
          id: "m-1",
          name: "Test <Alert> & Service",
          url: "http://example.com?a=1&b=2",
        },
        incident: {
          id: "inc-1",
          startedAt: "2026-11-19T10:57:55.000Z",
          resolvedAt: "2026-11-19T12:00:00.000Z",
          durationS: 3725,
        },
      };

      const text = telegramText(payload);
      expect(text).toContain("Test &lt;Alert&gt; &amp; Service");
      expect(text).toContain("http://example.com?a=1&amp;b=2");
      expect(text).toContain("Downtime: 1h 2m 5s");
      expect(text).toContain("🟢");
    });

    it("formats test notification", () => {
      const payload: AlertPayload = {
        event: "test",
        at: "2026-11-19T12:00:00.000Z",
        cause: null,
        monitor: null,
        incident: null,
      };
      expect(telegramText(payload)).toBe(
        "✅ Pharos test notification: this channel works."
      );
    });

    it("formats incident_opened with cause and since", () => {
      const payload: AlertPayload = {
        event: "incident_opened",
        at: "2026-11-19T12:00:00.000Z",
        cause: "refused",
        monitor: {
          id: "m-1",
          name: "API Server",
          url: "http://api.internal/health",
        },
        incident: {
          id: "inc-1",
          startedAt: "2026-11-19T12:00:00.000Z",
          resolvedAt: null,
          durationS: null,
        },
      };
      const text = telegramText(payload);
      expect(text).toContain("🔴 <b>API Server</b> is DOWN");
      expect(text).toContain("Cause: refused");
      expect(text).toContain("Since: 2026-11-19T12:00:00.000Z");
    });
  });
});
