import http from "node:http";

const port = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 9000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const pathname = url.pathname;

  if (pathname === "/ok") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello pharos");
    return;
  }

  if (pathname === "/slow") {
    const msParam = url.searchParams.get("ms");
    const delay = msParam ? parseInt(msParam, 10) : 3000;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("slow response");
    }, delay);
    return;
  }

  const statusMatch = pathname.match(/^\/status\/(\d+)$/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(`status ${code}`);
    return;
  }

  if (pathname === "/flaky") {
    const pParam = url.searchParams.get("p");
    const prob = pParam !== null ? parseFloat(pParam) : 0.3;
    if (Math.random() < prob) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("flaky error");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    }
    return;
  }

  if (pathname === "/redirect") {
    res.writeHead(302, { Location: "/ok" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`mock target server listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
