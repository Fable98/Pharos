import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { assertAllowedUrl, BlockedTargetError, guardedLookup } from "./ssrf";

export interface ProbeOptions {
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  expectedStatus?: number[];
  keyword?: string;
  allowPrivate?: boolean;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  errorCode: string | null;
  redirects: number;
}

function classifyError(err: any, signal: AbortSignal): string {
  if (err instanceof BlockedTargetError || err?.code === "PHAROS_BLOCKED") {
    return "blocked";
  }
  if (
    signal.aborted ||
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    err?.code === "ABORT_ERR"
  ) {
    return "timeout";
  }
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN" || err?.code === "ENODATA") {
    return "dns";
  }
  if (err?.code === "ECONNREFUSED") {
    return "refused";
  }
  if (err?.code === "ECONNRESET") {
    return "reset";
  }
  if (
    err?.code?.startsWith?.("ERR_TLS_") ||
    err?.code === "CERT_HAS_EXPIRED" ||
    err?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    err?.code?.includes?.("CERT") ||
    err?.code?.includes?.("TLS") ||
    err?.message?.includes?.("SSL") ||
    err?.message?.includes?.("certificate")
  ) {
    return "tls";
  }
  if (err?.code === "ERR_INVALID_URL" || err instanceof TypeError) {
    return "invalid_url";
  }
  return "network";
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export async function probeHttp(options: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const expectedStatus = options.expectedStatus ?? [200];
  const allowPrivate = options.allowPrivate ?? false;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const keyword = options.keyword;
  const initialMethod = keyword ? "GET" : (options.method ?? "GET");

  const probeStart = performance.now();
  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      ttfbMs: null,
      errorCode: "timeout",
      redirects: 0,
    };
  }

  let currentUrlStr = options.url;
  let redirects = 0;
  const visitedUrls = new Set<string>();

  let hopDnsMs: number | null = null;
  let hopTcpMs: number | null = null;
  let hopTlsMs: number | null = null;
  let hopTtfbMs: number | null = null;

  let currentMethod = initialMethod;

  while (true) {
    let currentUrl: URL;
    try {
      currentUrl = assertAllowedUrl(currentUrlStr, allowPrivate);
    } catch (err: any) {
      const isBlocked = err instanceof BlockedTargetError || err?.code === "PHAROS_BLOCKED";
      return {
        ok: false,
        statusCode: null,
        latencyMs: Math.round(performance.now() - probeStart),
        dnsMs: hopDnsMs,
        tcpMs: hopTcpMs,
        tlsMs: hopTlsMs,
        ttfbMs: hopTtfbMs,
        errorCode: isBlocked ? "blocked" : "invalid_url",
        redirects,
      };
    }

    if (visitedUrls.has(currentUrl.href)) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: Math.round(performance.now() - probeStart),
        dnsMs: hopDnsMs,
        tcpMs: hopTcpMs,
        tlsMs: hopTlsMs,
        ttfbMs: hopTtfbMs,
        errorCode: "too_many_redirects",
        redirects,
      };
    }
    visitedUrls.add(currentUrl.href);

    const isHttps = currentUrl.protocol === "https:";
    const client = isHttps ? https : http;

    hopDnsMs = null;
    hopTcpMs = null;
    hopTlsMs = null;
    hopTtfbMs = null;

    let lookupTime: number | null = null;
    let connectTime: number | null = null;
    let secureConnectTime: number | null = null;

    try {
      const hopStart = performance.now();

      const hopResult = await new Promise<{
        res: http.IncomingMessage;
        body: string;
      }>((resolve, reject) => {
        const reqOptions: http.RequestOptions = {
          method: currentMethod,
          agent: false,
          signal,
          headers: {
            "user-agent": "Pharos/1.0",
            accept: "*/*",
          },
        };

        if (!allowPrivate) {
          reqOptions.lookup = guardedLookup;
        }

        const req = client.request(currentUrl, reqOptions, (res) => {
          hopTtfbMs = Math.round(performance.now() - hopStart);

          // If it's a redirect and not in expectedStatus, we don't need the body
          const isRedirect =
            REDIRECT_STATUS_CODES.has(res.statusCode ?? 0) &&
            !expectedStatus.includes(res.statusCode ?? 0);

          if (isRedirect) {
            res.resume();
            resolve({ res, body: "" });
            return;
          }

          const chunks: Buffer[] = [];
          let bytesRead = 0;

          res.on("data", (chunk: Buffer) => {
            if (bytesRead < maxBodyBytes) {
              const remaining = maxBodyBytes - bytesRead;
              chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
            }
            bytesRead += chunk.length;
          });

          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ res, body });
          });

          res.on("error", (err) => {
            reject(err);
          });
        });

        req.on("socket", (socket) => {
          socket.on("lookup", () => {
            if (lookupTime === null) {
              lookupTime = performance.now();
              hopDnsMs = Math.round(lookupTime - hopStart);
            }
          });

          socket.on("connect", () => {
            connectTime = performance.now();
            hopTcpMs = Math.round(connectTime - (lookupTime ?? hopStart));
          });

          socket.on("secureConnect", () => {
            secureConnectTime = performance.now();
            hopTlsMs =
              connectTime !== null
                ? Math.round(secureConnectTime - connectTime)
                : Math.round(secureConnectTime - hopStart);
          });
        });

        req.on("error", (err) => {
          reject(err);
        });

        req.end();
      });

      const { res, body } = hopResult;
      const statusCode = res.statusCode ?? null;

      // Check if redirect
      if (
        statusCode !== null &&
        REDIRECT_STATUS_CODES.has(statusCode) &&
        !expectedStatus.includes(statusCode)
      ) {
        const location = res.headers.location;
        if (location) {
          redirects++;
          if (redirects > maxRedirects) {
            return {
              ok: false,
              statusCode,
              latencyMs: Math.round(performance.now() - probeStart),
              dnsMs: hopDnsMs,
              tcpMs: hopTcpMs,
              tlsMs: hopTlsMs,
              ttfbMs: hopTtfbMs,
              errorCode: "too_many_redirects",
              redirects,
            };
          }

          let nextUrl: URL;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            return {
              ok: false,
              statusCode,
              latencyMs: Math.round(performance.now() - probeStart),
              dnsMs: hopDnsMs,
              tcpMs: hopTcpMs,
              tlsMs: hopTlsMs,
              ttfbMs: hopTtfbMs,
              errorCode: "invalid_url",
              redirects,
            };
          }

          if (statusCode === 303) {
            currentMethod = "GET";
          }

          currentUrlStr = nextUrl.href;
          continue;
        }
      }

      // Final response reached
      const latencyMs = Math.round(performance.now() - probeStart);

      if (statusCode === null || !expectedStatus.includes(statusCode)) {
        return {
          ok: false,
          statusCode,
          latencyMs,
          dnsMs: hopDnsMs,
          tcpMs: hopTcpMs,
          tlsMs: hopTlsMs,
          ttfbMs: hopTtfbMs,
          errorCode: "status_mismatch",
          redirects,
        };
      }

      if (keyword && !body.includes(keyword)) {
        return {
          ok: false,
          statusCode,
          latencyMs,
          dnsMs: hopDnsMs,
          tcpMs: hopTcpMs,
          tlsMs: hopTlsMs,
          ttfbMs: hopTtfbMs,
          errorCode: "keyword_missing",
          redirects,
        };
      }

      return {
        ok: true,
        statusCode,
        latencyMs,
        dnsMs: hopDnsMs,
        tcpMs: hopTcpMs,
        tlsMs: hopTlsMs,
        ttfbMs: hopTtfbMs,
        errorCode: null,
        redirects,
      };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - probeStart);
      const errCode = classifyError(err, signal);
      return {
        ok: false,
        statusCode: null,
        latencyMs,
        dnsMs: hopDnsMs,
        tcpMs: hopTcpMs,
        tlsMs: hopTlsMs,
        ttfbMs: hopTtfbMs,
        errorCode: errCode,
        redirects,
      };
    }
  }
}
