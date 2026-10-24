import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createPrototypeServer } from "./server.mjs";
import { createGateway } from "./mcp-gateway.mjs";
import { DemoGateway } from "./demo-gateway.mjs";
import { RoomStore } from "./room-store.mjs";
import { GroupService } from "./group-service.mjs";
import { createGroupApi } from "./group-http.mjs";
import { digest } from "./room.mjs";
import { createLocator } from "./location.mjs";

const names = [
  "group.html", "group.mjs", "group-render.mjs", "join.html", "join.mjs", "group.css",
  "group-shared.mjs", "paid-desk.mjs", "place-media.mjs", "menu-photo.mjs", "restaurant-view.mjs", "location-ui.mjs",
];
export function groupAssets() {
  return names.map((name) => [`/${name}`, [name,
    name.endsWith(".html") ? "text/html; charset=utf-8" :
      name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"]]);
}

export async function launchGroup({ gateway, directory, host = "127.0.0.1", port = 0, organizerKey, locator = null }) {
  const service = new GroupService(gateway, new RoomStore(directory));
  service.locator = locator;
  await service.initialize();
  const origins = [];
  const handler = createGroupApi(service, { organizerHash: digest(organizerKey), shareOrigins: origins });
  const server = createPrototypeServer({ api: handler, allowLan: host === "0.0.0.0", extraAssets: groupAssets() });
  const listening = once(server, "listening");
  server.listen(port, host);
  await listening;
  const actualPort = server.address().port;
  if (host === "0.0.0.0") {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      if (/docker|veth|br-|wsl|vethernet/i.test(name)) continue;
      for (const entry of addresses ?? []) {
        if (entry.family === "IPv4" && !entry.internal &&
            /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address)) {
          origins.push(`http://${entry.address}:${actualPort}`);
        }
      }
    }
  }
  return { server, service, url: `http://127.0.0.1:${actualPort}/group.html`, shareOrigins: origins };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let demo = false, tokenFile = null, host = "127.0.0.1", port = 0;
    for (let i = 0; i < args.length; i += 1) {
      switch (args[i]) {
        case "--demo": demo = true; break;
        case "--token-file": tokenFile = args[++i]; if (!tokenFile) throw new Error("缺少凭据文件路径。"); break;
        case "--host": host = args[++i]; break;
        case "--port": port = Number(args[++i]); break;
        default: throw new Error("未知启动参数。");
      }
    }
    if (!["127.0.0.1", "0.0.0.0"].includes(host) ||
        !Number.isInteger(port) || port < 0 || port > 65535 || (demo && tokenFile)) {
      throw new Error("请核对监听地址、端口及演示参数。");
    }
    const token = demo ? null : tokenFile
      ? (await readFile(tokenFile, "utf8")).trim() : process.env.MCD_MCP_TOKEN?.trim();
    const gateway = demo ? new DemoGateway() : createGateway({ token });
    const organizerKey = process.env.BAGDESK_ADMIN_KEY ?? randomBytes(24).toString("base64url");
    if (organizerKey.length < 24) throw new Error("管理口令至少24字符。");
    const directory = fileURLToPath(new URL(demo ? "../.omo/bagdesk-demo/" : "../.omo/bagdesk-rooms/", import.meta.url));
    const locator = demo ? null : createLocator({ key: process.env.AMAP_WEB_SERVICE_KEY });
    const running = await launchGroup({ gateway, directory, host, port, organizerKey, locator });
    console.log(`GROUP_READY ${running.url}`);
    console.log(`本机管理口令：${organizerKey}`);
    console.log(`模式：${demo ? "合成演示，不收费" : "真实MCP，创建订单仍须点餐员明确确认"}`);
    for (const origin of running.shareOrigins) console.log(`局域网电脑/手机访问地址：${origin}/join.html`);
  } catch (error) {
    console.error(error.name === "GatewayError" ? error.message : "共享餐桌未启动，请检查参数、端口和服务端凭据。");
    process.exitCode = 1;
  }
}
