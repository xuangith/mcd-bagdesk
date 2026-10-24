import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

const root = new URL("./", import.meta.url);
const allowed = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/showcase.html", ["showcase.html", "text/html; charset=utf-8"]],
  ...["app.mjs", "render.mjs", "import-flow.mjs", "paid-desk.mjs", "group-shared.mjs", "state.mjs", "order.mjs", "sample.mjs"]
    .map((name) => [`/${name}`, [name, "text/javascript; charset=utf-8"]]),
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/art.svg", ["art.svg", "image/svg+xml"]],
]);

export function createPrototypeServer({ api = null, allowLan = false, extraAssets = [] } = {}) {
  const assets = new Map([...allowed, ...extraAssets]);
  const hosts = new Set(["127.0.0.1", "localhost"]);
  if (allowLan) {
    for (const entry of Object.values(networkInterfaces()).flat().filter(Boolean)) {
      if (entry.family === "IPv4") hosts.add(entry.address);
    }
  }
  return createServer(async (request, response) => {
    const address = response.socket?.localPort;
    if (![...hosts].some((host) => `${host}:${address}` === request.headers.host)) {
      response.writeHead(403).end("Local access only.");
      return;
    }
    if (api && await api(request, response)) return;
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Read-only local prototype.");
      return;
    }
    const path = new URL(request.url, "http://localhost").pathname;
    const asset = assets.get(path);
    if (!asset) {
      response.writeHead(404).end("Not found.");
      return;
    }
    try {
      const body = await readFile(new URL(asset[0], root));
      const showcaseScript = asset[0] === "showcase.html"
        ? body.toString("utf8").match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] : null;
      const scriptHash = showcaseScript
        ? ` 'sha256-${createHash("sha256").update(showcaseScript).digest("base64")}'` : "";
      response.writeHead(200, {
        "Content-Type": asset[1],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'self'; script-src 'self'${scriptHash}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://menu-img.mcd.cn https://img.mcd.cn https://cms-cdn.mcd.cn; connect-src ${api ? "'self'" : "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end("Not found.");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BAGDESK_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("BAGDESK_PORT 应为0至65535的整数。");
    process.exitCode = 1;
  } else {
    const server = createPrototypeServer();
    const listening = once(server, "listening");
    server.listen(port, "127.0.0.1");
    try {
      await listening;
      console.log(`BAGDESK_READY http://127.0.0.1:${server.address().port}`);
    } catch {
      console.error("无法启动本地原型，请检查端口是否被占用。");
      process.exitCode = 1;
    }
  }
}
