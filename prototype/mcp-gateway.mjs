const ENDPOINT = "https://mcp.mcd.cn";
const ALLOWED = new Set([
  "query-nearby-stores", "query-meals", "query-meal-detail",
  "calculate-price", "create-order", "query-order",
  "delivery-query-addresses", "delivery-query-stores",
]);
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export class GatewayError extends Error {
  constructor(code, message, uncertain = false) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

function parse(text) {
  try { return JSON.parse(text); }
  catch { throw new GatewayError("UPSTREAM_FORMAT", "官方服务响应无法解析。", true); }
}

async function responseResult(response, id) {
  if (!response.body) throw new GatewayError("UPSTREAM_EMPTY", "官方服务未返回结果。", true);
  const stream = response.headers.get("content-type")?.includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const match = (message) => {
    if (!record(message) || message.jsonrpc !== "2.0" || message.id !== id) {
      throw new GatewayError("UPSTREAM_FORMAT", "官方响应与本次请求不匹配。", true);
    }
    if (message.error || !record(message.result)) {
      throw new GatewayError("UPSTREAM_RPC", "官方 MCP 未完成本次调用。", true);
    }
    return message.result;
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        throw new GatewayError("UPSTREAM_SIZE", "官方返回超过读取上限。", true);
      }
      text += decoder.decode(next.value, { stream: true });
      if (!stream) continue;
      let separator = /\r?\n\r?\n/.exec(text);
      while (separator) {
        const frame = text.slice(0, separator.index);
        text = text.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data && data !== "[DONE]") {
          const message = parse(data);
          if (message.id === id) return match(message);
        }
        separator = /\r?\n\r?\n/.exec(text);
      }
    }
    if (stream) throw new GatewayError("UPSTREAM_EMPTY", "事件流未返回完整结果。", true);
    return match(parse(text + decoder.decode()));
  } finally {
    try { await reader.cancel(); }
    catch { /* 超时已中止网络流时仍需释放 reader。 */ }
    reader.releaseLock();
  }
}

function unpack(result) {
  if (result.isError) throw new GatewayError("UPSTREAM_TOOL", "官方工具未完成请求。", true);
  let payload = result.structuredContent;
  if (payload === undefined) {
    const texts = result.content?.filter((item) => item.type === "text");
    if (!Array.isArray(texts) || texts.length !== 1 || typeof texts[0].text !== "string") {
      throw new GatewayError("UPSTREAM_FORMAT", "官方工具结果缺少有效数据。", true);
    }
    payload = parse(texts[0].text);
  }
  if (!record(payload)) throw new GatewayError("UPSTREAM_FORMAT", "官方结果格式未知。", true);
  if (payload.success === false || payload.code !== 200) {
    const code = Number.isInteger(payload.code) ? String(payload.code) : "UPSTREAM_REJECTED";
    const message = code === "60006" ? "官方核价未通过：商品已售罄或当前不可售。" :
      "官方未接受本次请求，请核对门店、餐品或账户状态。";
    throw new GatewayError(code, message);
  }
  if (payload.data === undefined) throw new GatewayError("UPSTREAM_FORMAT", "官方结果缺少数据。", true);
  return payload.data;
}

export function createGateway({ token, request = fetch }) {
  if (typeof token !== "string" || token.length < 8 || /\s/.test(token)) {
    throw new GatewayError("MCP_TOKEN_REQUIRED", "请在服务端提供有效的麦当劳 MCP Token。");
  }
  let sequence = 0;
  let ready = null;
  const headers = {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const send = async (body) => {
    try {
      const response = await request(ENDPOINT, {
        method: "POST", headers: { ...headers }, redirect: "error",
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayError(`HTTP_${response.status}`,
          `麦当劳服务返回 HTTP ${response.status}。`, response.status >= 500);
      }
      const session = response.headers.get("mcp-session-id");
      if (session) headers["Mcp-Session-Id"] = session;
      if (body.id === undefined) {
        await response.body?.cancel();
        return {};
      }
      return await responseResult(response, body.id);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("MCP_CONNECTION", "官方连接中断或超时，本次没有自动重试。", true);
    }
  };
  const rpc = (method, params) =>
    send({ jsonrpc: "2.0", id: ++sequence, method, params });
  const initialize = () => ready ??= (async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "mcd-bagdesk", version: "0.2.0" },
    });
    if (response.protocolVersion !== "2024-11-05") {
      throw new GatewayError("MCP_VERSION", "官方选择了当前客户端未支持的协议版本。");
    }
    headers["MCP-Protocol-Version"] = response.protocolVersion;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  })().catch((error) => { ready = null; throw error; });
  return {
    mode: "live",
    async call(name, args) {
      if (!ALLOWED.has(name)) throw new GatewayError("TOOL_DENIED", "该工具不在本功能的调用范围内。");
      await initialize();
      return unpack(await rpc("tools/call", { name, arguments: args }));
    },
  };
}
