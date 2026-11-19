import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { assertAllowedUrl, guardedLookup } from "./ssrf";

export interface SafePostOptions {
  timeoutMs?: number;
  allowPrivate?: boolean;
}

export interface SafePostResult {
  status: number;
  body: string;
}

export async function safePostJson(
  url: string,
  bodyString: string,
  headers: Record<string, string> = {},
  options: SafePostOptions = {}
): Promise<SafePostResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const allowPrivate = options.allowPrivate ?? false;

  const parsedUrl = assertAllowedUrl(url, allowPrivate);
  const isHttps = parsedUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const bodyBuffer = Buffer.from(bodyString, "utf8");

  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
    "content-length": bodyBuffer.byteLength.toString(),
    "user-agent": "PharosWebhook/1.0",
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);

    const req = transport.request(
      parsedUrl,
      {
        method: "POST",
        agent: false,
        signal,
        lookup: allowPrivate ? dns.lookup : (guardedLookup as any),
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const MAX_BYTES = 4096;

        res.on("data", (chunk: Buffer) => {
          if (totalBytes < MAX_BYTES) {
            const remaining = MAX_BYTES - totalBytes;
            if (chunk.length <= remaining) {
              chunks.push(chunk);
              totalBytes += chunk.length;
            } else {
              chunks.push(chunk.subarray(0, remaining));
              totalBytes += remaining;
              res.destroy(); // reached 4 KB
            }
          }
        });

        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body,
          });
        });

        res.on("close", () => {
          if (!res.readableEnded && totalBytes >= MAX_BYTES) {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              body,
            });
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.write(bodyBuffer);
    req.end();
  });
}
