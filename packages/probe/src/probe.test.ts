import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeHttp } from "./probe";
import { assertAllowedUrl, BlockedTargetError, guardedLookup, isPublicAddress } from "./ssrf";

describe("packages/probe", () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello pharos");
      } else if (url.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("slow response");
        }, 2000);
      } else if (url.pathname === "/500") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error");
      } else if (url.pathname === "/redirect") {
        res.writeHead(302, { Location: "/ok" });
        res.end();
      } else if (url.pathname === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("ssrf - public vs blocked addresses", () => {
    it("allows public addresses", () => {
      expect(isPublicAddress("8.8.8.8")).toBe(true);
      expect(isPublicAddress("1.1.1.1")).toBe(true);
      expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    });

    it("blocks non-public addresses", () => {
      const blocked = [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
      ];
      for (const ip of blocked) {
        expect(isPublicAddress(ip)).toBe(false);
      }
    });

    it("loopback literal blocked by default in assertAllowedUrl", () => {
      expect(() => assertAllowedUrl(`http://127.0.0.1:${serverPort}/ok`)).toThrow(
        BlockedTargetError
      );
      expect(() =>
        assertAllowedUrl(`http://127.0.0.1:${serverPort}/ok`, false)
      ).toThrow(BlockedTargetError);
      expect(() =>
        assertAllowedUrl(`http://127.0.0.1:${serverPort}/ok`, true)
      ).not.toThrow();
    });

    it("169.254.169.254 blocked without connecting", async () => {
      const res = await probeHttp({
        url: "http://169.254.169.254/latest/meta-data/",
        allowPrivate: false,
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("blocked");
    });

    it("ftp:// blocked", async () => {
      const res = await probeHttp({
        url: "ftp://example.com/file",
        allowPrivate: false,
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("blocked");
    });

    it('guardedLookup("localhost") rejects with PHAROS_BLOCKED', async () => {
      await expect(
        new Promise((resolve, reject) => {
          guardedLookup("localhost", (err: any, addr: any) => {
            if (err) reject(err);
            else resolve(addr);
          });
        })
      ).rejects.toMatchObject({
        code: "PHAROS_BLOCKED",
      });
    });
  });

  describe("probeHttp", () => {
    it("loopback literal blocked by default in probeHttp", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/ok`,
        allowPrivate: false,
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("blocked");
    });

    it("success on valid response", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/ok`,
        allowPrivate: true,
        expectedStatus: [200],
      });
      expect(res.ok).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.errorCode).toBeNull();
      expect(res.latencyMs).toBeTypeOf("number");
    });

    it("status_mismatch when status not in expectedStatus", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/500`,
        allowPrivate: true,
        expectedStatus: [200],
      });
      expect(res.ok).toBe(false);
      expect(res.statusCode).toBe(500);
      expect(res.errorCode).toBe("status_mismatch");
    });

    it("keyword match and keyword_missing", async () => {
      const matchRes = await probeHttp({
        url: `${serverUrl}/ok`,
        allowPrivate: true,
        expectedStatus: [200],
        keyword: "hello pharos",
      });
      expect(matchRes.ok).toBe(true);
      expect(matchRes.errorCode).toBeNull();

      const missingRes = await probeHttp({
        url: `${serverUrl}/ok`,
        allowPrivate: true,
        expectedStatus: [200],
        keyword: "missing keyword",
      });
      expect(missingRes.ok).toBe(false);
      expect(missingRes.errorCode).toBe("keyword_missing");
    });

    it("timeout when request exceeds timeoutMs", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/slow`,
        allowPrivate: true,
        expectedStatus: [200],
        timeoutMs: 150,
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("timeout");
    });

    it("redirect followed (redirects === 1)", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/redirect`,
        allowPrivate: true,
        expectedStatus: [200],
      });
      expect(res.ok).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.redirects).toBe(1);
      expect(res.errorCode).toBeNull();
    });

    it("redirect loop gives too_many_redirects", async () => {
      const res = await probeHttp({
        url: `${serverUrl}/loop`,
        allowPrivate: true,
        expectedStatus: [200],
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("too_many_redirects");
    });

    it("connection refused on 127.0.0.1:9 gives refused", async () => {
      const res = await probeHttp({
        url: "http://127.0.0.1:9",
        allowPrivate: true,
        expectedStatus: [200],
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("refused");
    });
  });
});
