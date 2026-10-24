import { timingSafeEqual } from "node:crypto";
import { digest, memberView, organizerView, RoomError } from "./room.mjs";
import { addressFingerprint, addressView } from "./fulfillment.mjs";

export function secretMatches(value, expected) {
  if (typeof value !== "string" || value.length > 128 ||
      typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(expected, "hex"));
}

function readBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new RoomError("JSON_REQUIRED", "此操作需要 JSON 请求。", 415);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32768 && !finished) {
        finished = true;
        chunks.length = 0;
        reject(new RoomError("BODY_LIMIT", "请求超过32 KB上限。", 413));
      }
      if (!finished) chunks.push(chunk);
    });
    request.on("end", () => {
      request.setTimeout(0);
      if (finished) return;
      finished = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new RoomError("INVALID_JSON", "请求内容不是有效 JSON 对象。", 400)); }
    });
    request.on("error", () => {
      if (!finished) { finished = true; reject(new RoomError("REQUEST_INTERRUPTED", "请求已中断。", 400)); }
    });
    request.setTimeout(10000, () => {
      if (!finished) {
        finished = true;
        reject(new RoomError("REQUEST_TIMEOUT", "请求读取超时。", 408));
        request.destroy();
      }
    });
  });
}

function fields(body, allowed, version = false) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new RoomError("UNEXPECTED_FIELD", "请求包含不支持的字段。", 400);
  }
  if (version && (!Number.isInteger(body.version) || body.version < 1)) {
    throw new RoomError("VERSION_REQUIRED", "请先刷新餐桌版本。", 400);
  }
  return body;
}

export function createGroupApi(service, { organizerHash, shareOrigins = [] }) {
  const admin = (request) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) ||
        !secretMatches(request.headers["x-organizer-key"], organizerHash)) {
      throw new RoomError("ORGANIZER_REQUIRED", "请在组织者电脑上使用正确的管理口令。", 403);
    }
  };
  const ownMember = (request, room) => {
    const member = room.members.find((item) => secretMatches(request.headers["x-member-key"], item.keyHash));
    if (!member) throw new RoomError("MEMBER_REQUIRED", "请通过邀请加入本桌。", 403);
    return member;
  };
  const view = (room) => {
    const address = service.directory.addresses.get(room.fulfillment?.addressId);
    return { ...organizerView(room, service.paymentUrls.get(room.id) ?? null),
      deliveryAddress: address ? { ...addressView(address), hash: addressFingerprint(address) } : null };
  };
  const response = (res, value, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      ...(status === 413 ? { Connection: "close" } : {}),
    });
    res.end(JSON.stringify(value));
  };
  return async (request, res) => {
    let url;
    try { url = new URL(request.url, "http://localhost"); }
    catch {
      response(res, { error: { code: "URL_FORMAT", message: "请求地址无效。" } }, 400);
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        throw new RoomError("ORIGIN_DENIED", "不接受跨站请求。", 403);
      }
      const method = request.method;
      if (url.pathname === "/api/config" && method === "GET") {
        const config = { mode: service.gateway.mode, localOnlyOrganizer: true, geolocationConfigured: !!service.locator };
        if (request.headers["x-organizer-key"]) {
          admin(request);
          config.shareOrigins = shareOrigins;
        }
        response(res, config); return true;
      }
      if (url.pathname === "/api/stores" && method === "GET") {
        admin(request);
        const stores = url.searchParams.get("mode") === "delivery"
          ? await service.directory.delivery(url.searchParams.get("addressId"))
          : url.searchParams.get("source") === "favorites" ? await service.directory.favorites()
            : await service.searchStores(url.searchParams.get("city"), url.searchParams.get("keyword"));
        response(res, { stores });
        return true;
      }
      if (url.pathname === "/api/addresses" && method === "GET") {
        admin(request);
        response(res, { addresses: await service.directory.loadAddresses() });
        return true;
      }
      if (url.pathname === "/api/location-stores" && method === "POST") {
        admin(request);
        if (!service.locator) throw new RoomError("MAP_NOT_CONFIGURED", "点餐员尚未配置地图服务，可先用收藏餐厅或地标查找。", 503);
        const body = fields(await readBody(request), ["latitude", "longitude", "accuracy", "consent"]);
        response(res, await service.locator.nearby(service.directory, body));
        return true;
      }
      if (url.pathname === "/api/rooms") {
        admin(request);
        if (method === "GET") {
          response(res, { rooms: [...service.rooms.values()].map((room) => ({
            id: room.id, title: room.title, phase: room.phase, version: room.version,
            storeName: room.store.storeName, createdAt: room.createdAt,
          })) });
          return true;
        }
        if (method === "POST") {
          const result = await service.create(fields(await readBody(request), ["title", "storeCode"]));
          response(res, { room: view(result.room), joinKey: result.joinKey });
          return true;
        }
      }
      const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/);
      if (!match) throw new RoomError("NOT_FOUND", "没有这个接口。", 404);
      const [, id, operation = ""] = match;
      const room = service.room(id);
      if (operation === "join") {
        if (method === "GET") {
          if (!secretMatches(request.headers["x-join-key"], room.joinHash)) {
            throw new RoomError("INVITE_REQUIRED", "邀请无效，请向点餐员获取新链接。", 403);
          }
          response(res, memberView(room)); return true;
        }
        if (method === "POST") {
          const body = fields(await readBody(request), ["joinKey", "name"]);
          if (!secretMatches(body.joinKey, room.joinHash)) throw new RoomError("INVITE_REQUIRED", "邀请无效。", 403);
          const result = await service.join(id, body);
          response(res, { memberKey: result.memberKey, room: memberView(result.room, result.member) });
          return true;
        }
      }
      if (operation === "me" && method === "GET") {
        response(res, memberView(room, ownMember(request, room))); return true;
      }
      if (operation === "wishes" && method === "PUT") {
        const member = ownMember(request, room);
        const body = fields(await readBody(request), ["revision", "items"]);
        const next = await service.wishes(id, member.id, body);
        response(res, memberView(next, next.members.find((item) => item.id === member.id)));
        return true;
      }
      admin(request);
      if (!operation && method === "GET") {
        if (room.fulfillment?.mode === "delivery") await service.directory.loadAddresses();
        response(res, view(room)); return true;
      }
      if (operation === "desk" && method === "GET") { response(res, service.desk(id)); return true; }
      if (method !== "POST") throw new RoomError("METHOD_DENIED", "此接口不支持这种请求方法。", 405);
      const body = await readBody(request);
      let result;
      switch (operation) {
        case "plan":
          fields(body, ["version"], true); result = await service.plan(id, body.version); break;
        case "reopen":
          fields(body, ["version"], true); result = await service.reopen(id, body.version); break;
        case "invite": {
          fields(body, ["version"], true);
          const invited = await service.invite(id, body.version);
          response(res, { room: view(invited.room), joinKey: invited.joinKey }); return true;
        }
        case "select": {
          fields(body, ["version", "planId", "takeWayCode", "addressHash"], true);
          const selected = await service.select(id, body);
          response(res, { room: view(selected.room), nonce: selected.nonce }); return true;
        }
        case "order":
          fields(body, ["version", "nonce", "confirmed"], true); result = await service.order(id, body); break;
        case "check-payment":
          fields(body, []); result = await service.verify(id); break;
        case "recover":
          fields(body, ["version", "orderId"], true); result = await service.recover(id, body); break;
        case "release":
          fields(body, ["version", "confirmNoOrder"], true); result = await service.release(id, body); break;
        case "desk":
          fields(body, ["deskVersion", "action"]);
          response(res, await service.deskAction(id, body)); return true;
        case "demo-paid":
          fields(body, []);
          if (service.gateway.mode !== "demo" || typeof service.gateway.markDemoPaid !== "function") {
            throw new RoomError("NOT_FOUND", "真实模式没有模拟付款接口。", 404);
          }
          if (!room.order?.orderId) throw new RoomError("ORDER_REQUIRED", "请先创建合成演示订单。");
          service.gateway.markDemoPaid(room.order.orderId);
          result = await service.verify(id); break;
        default: throw new RoomError("NOT_FOUND", "没有这个接口。", 404);
      }
      response(res, view(result));
    } catch (error) {
      const status = error instanceof RoomError ? error.status :
        ["DeskError", "OrderError", "PlanningError"].includes(error.name) ? 400 :
          ["GatewayError", "CatalogError"].includes(error.name) ? 502 : 500;
      if (status === 500) console.error("BAGDESK_API_ERROR", error.code ?? error.name);
      response(res, { error: {
        code: typeof error.code === "string" ? error.code : "SERVICE_ERROR",
        message: status === 500 ? "本地服务未完成操作，请核对状态后重试。" : error.message,
      } }, status);
    }
    return true;
  };
}
