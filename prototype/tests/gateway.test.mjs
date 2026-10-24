import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGateway } from "../mcp-gateway.mjs";

test("the official adapter preserves authentication and does not retry uncertain writes", { timeout: 5000 }, async (t) => {
  // Given: a real local HTTP boundary with synthetic credentials.
  let tools = 0;
  const token = "SYNTHETIC_MCP_TOKEN";
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    response.setHeader("Content-Type", "application/json");
    if (body.method === "initialize") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } }));
    } else if (body.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else {
      tools += 1;
      response.writeHead(503).end(token);
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const gateway = createGateway({ token, request: (url, options) => {
    assert.equal(url, "https://mcp.mcd.cn");
    assert.equal(options.redirect, "error");
    return fetch(`http://127.0.0.1:${server.address().port}`, options);
  } });
  // When / Then
  await assert.rejects(gateway.call("create-order", {}), (error) =>
    error.code === "HTTP_503" && error.uncertain === true && !error.message.includes(token));
  assert.equal(tools, 1);
});
