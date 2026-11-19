import http from "node:http";
import crypto from "node:crypto";

const port = process.env.WEBHOOK_PORT
  ? parseInt(process.env.WEBHOOK_PORT, 10)
  : 9100;

const server = http.createServer((req, res) => {
  const secret = process.env.WEBHOOK_SECRET ?? "";
  const signatureHeader = req.headers["x-pharos-signature"] as string | undefined;
  const timestampHeader = req.headers["x-pharos-timestamp"] as string | undefined;
  const eventHeader = req.headers["x-pharos-event"] as string | undefined;
  const eventIdHeader = req.headers["x-pharos-event-id"] as string | undefined;

  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
  });

  req.on("end", () => {
    const timestamp = timestampHeader ? parseInt(timestampHeader, 10) : NaN;
    const nowS = Math.floor(Date.now() / 1000);

    let isValid = false;

    if (!isNaN(timestamp) && Math.abs(nowS - timestamp) < 300 && secret) {
      const expectedSignature =
        "sha256=" +
        crypto
          .createHmac("sha256", secret)
          .update(`${timestamp}.${rawBody}`)
          .digest("hex");

      if (
        signatureHeader &&
        signatureHeader.length === expectedSignature.length
      ) {
        isValid = crypto.timingSafeEqual(
          Buffer.from(signatureHeader),
          Buffer.from(expectedSignature)
        );
      }
    }

    if (isValid) {
      console.log("VALID", {
        event: eventHeader,
        id: eventIdHeader,
        body: rawBody,
      });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } else {
      console.log("REJECTED", {
        event: eventHeader,
        id: eventIdHeader,
        body: rawBody,
      });
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
    }
  });
});

server.listen(port, () => {
  console.log(`webhook receiver listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
