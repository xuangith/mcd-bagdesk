import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createPrototypeServer } from "../server.mjs";

test("local server exposes only prototype assets with a restrictive browser policy", { timeout: 3000 }, async (t) => {
  // Given
  const server = createPrototypeServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  // When
  const responses = await Promise.all([
    fetch(`${root}/state.mjs`),
    fetch(`${root}/../token.txt`),
    fetch(`${root}/.omo/PUBLISH.md`),
    fetch(`${root}/state.mjs`, { method: "POST" }),
  ]);
  const hostileStatus = await new Promise((resolve, reject) => {
    const call = request(`${root}/state.mjs`, { headers: { Host: "other.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on("error", reject);
    call.end();
  });
  // Then
  assert.deepEqual([...responses.map((response) => response.status), hostileStatus], [200, 404, 404, 405, 403]);
  assert.match(responses[0].headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal(responses[0].headers.get("cache-control"), "no-store");
  await Promise.all(responses.map((response) => response.body?.cancel()));
});
