import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { launchGroup } from "../group-server.mjs";
import { DemoGateway } from "../demo-gateway.mjs";

const KEY = "synthetic-organizer-key-only-for-tests";
async function httpFixture(t, host = "127.0.0.1") {
  const directory = await mkdtemp(join(tmpdir(), "bagdesk-http-"));
  const gateway = new DemoGateway();
  const running = await launchGroup({ gateway, directory, host, organizerKey: KEY });
  t.after(async () => {
    running.server.closeAllConnections();
    await new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = new URL(running.url).origin;
  const call = async (path, { method = "GET", body, headers = {}, as = "organizer" } = {}) => {
    const response = await fetch(origin + path, {
      method, headers: {
        ...(as === "organizer" ? { "X-Organizer-Key": KEY } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { ...running, gateway, origin, call };
}
async function roomFixture(t) {
  const context = await httpFixture(t);
  await context.call("/api/stores?city=demo&keyword=demo");
  const created = await context.call("/api/rooms", {
    method: "POST", body: { title: "HTTP测试桌", storeCode: "900001" },
  });
  assert.equal(created.status, 200);
  return { ...context, room: created.data.room, joinKey: created.data.joinKey };
}

test("member capabilities cannot read or invoke organizer operations", { timeout: 10000 }, async (t) => {
  // Given
  const { call, room, joinKey, gateway } = await roomFixture(t);
  const joined = await call(`/api/rooms/${room.id}/join`, {
    as: "guest", method: "POST", body: { joinKey, name: "手机成员" },
  });
  const memberKey = joined.data.memberKey;
  // When
  const [hidden, forged, me] = await Promise.all([
    call(`/api/rooms/${room.id}`, { as: "guest", headers: { "X-Member-Key": memberKey } }),
    call(`/api/rooms/${room.id}/order`, {
      as: "guest", method: "POST", headers: { "X-Organizer-Key": memberKey },
      body: { version: 2, nonce: "forged", confirmed: true },
    }),
    call(`/api/rooms/${room.id}/me`, { as: "guest", headers: { "X-Member-Key": memberKey } }),
  ]);
  // Then
  assert.equal(hidden.status, 403);
  assert.equal(forged.status, 403);
  assert.equal(me.status, 200);
  assert.equal(me.data.me.name, "手机成员");
  assert.equal(JSON.stringify(me.data).includes("keyHash"), false);
  assert.equal(JSON.stringify(me.data).includes("paymentUrl"), false);
  assert.equal(gateway.createCalls, 0);
});

test("only a member's own wishes can be changed and package codes are rejected", { timeout: 10000 }, async (t) => {
  // Given
  const { call, room, joinKey, service } = await roomFixture(t);
  const first = (await call(`/api/rooms/${room.id}/join`, {
    as: "guest", method: "POST", body: { joinKey, name: "成员甲" },
  })).data;
  await call(`/api/rooms/${room.id}/join`, { as: "guest", method: "POST", body: { joinKey, name: "成员乙" } });
  const headers = { "X-Member-Key": first.memberKey };
  // When
  const badPackage = await call(`/api/rooms/${room.id}/wishes`, {
    as: "guest", method: "PUT", headers, body: { revision: 0, items: [{ sku: "9900005456", quantity: 1 }] },
  });
  const injectedOwner = await call(`/api/rooms/${room.id}/wishes`, {
    as: "guest", method: "PUT", headers, body: { revision: 0, memberId: "someone-else", items: [] },
  });
  const valid = await call(`/api/rooms/${room.id}/wishes`, {
    as: "guest", method: "PUT", headers, body: { revision: 0, items: [{ sku: "1440", quantity: 1 }] },
  });
  // Then
  assert.equal(badPackage.status, 400);
  assert.equal(injectedOwner.status, 400);
  assert.equal(valid.status, 200);
  assert.equal(service.room(room.id).members.find((member) => member.name === "成员乙").submitted, false);
  assert.equal(valid.data.menu.every((item) => typeof item.menuGroup === "string"), true);
});

test("cross-origin writes, missing versions and oversized bodies fail before business actions", { timeout: 10000 }, async (t) => {
  // Given
  const { call, room, gateway } = await roomFixture(t);
  // When
  const cross = await call(`/api/rooms/${room.id}/plan`, {
    method: "POST", headers: { Origin: "https://other.invalid" }, body: { version: room.version },
  });
  const missing = await call(`/api/rooms/${room.id}/plan`, { method: "POST", body: {} });
  const large = await call("/api/rooms", { method: "POST", body: { payload: "x".repeat(40000) } });
  // Then
  assert.equal(cross.status, 403);
  assert.equal(missing.status, 400);
  assert.equal(large.status, 413);
  assert.equal(gateway.createCalls, 0);
});

test("the demo paid route cannot be used in a live-mode service", { timeout: 10000 }, async (t) => {
  // Given
  const { call, room, gateway, service } = await roomFixture(t);
  gateway.mode = "live";
  // When
  const response = await call(`/api/rooms/${room.id}/demo-paid`, { method: "POST", body: {} });
  // Then
  assert.equal(response.status, 404);
  assert.equal(service.room(room.id).desk, null);
});

test("a LAN socket cannot obtain organizer access even with its key", { timeout: 10000 }, async (t) => {
  // Given
  const { server } = await httpFixture(t, "0.0.0.0");
  const address = Object.values(networkInterfaces()).flat().find((entry) =>
    entry?.family === "IPv4" && !entry.internal)?.address;
  assert.ok(address);
  // When
  const response = await fetch(`http://${address}:${server.address().port}/api/rooms`, {
    headers: { "X-Organizer-Key": KEY }, signal: AbortSignal.timeout(3000),
  });
  // Then
  assert.equal(response.status, 403);
  await response.body?.cancel();
});

test("LAN members can join and submit wishes without access to addresses or organizer data", { timeout: 10000 }, async (t) => {
  // Given
  const { call, server } = await httpFixture(t, "0.0.0.0");
  await call("/api/stores?city=demo&keyword=demo");
  const created = (await call("/api/rooms", {
    method: "POST", body: { title: "局域网测试桌", storeCode: "900001" },
  })).data;
  const address = Object.values(networkInterfaces()).flat().find((entry) =>
    entry?.family === "IPv4" && !entry.internal)?.address;
  assert.ok(address);
  const origin = `http://${address}:${server.address().port}`;
  const roomPath = `/api/rooms/${created.room.id}`;
  // When
  const page = await fetch(`${origin}/join.html`);
  const joined = await fetch(`${origin}${roomPath}/join`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ joinKey: created.joinKey, name: "局域网电脑成员" }),
  });
  assert.equal(joined.status, 200);
  const identity = await joined.json();
  const submitted = await fetch(`${origin}${roomPath}/wishes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin, "X-Member-Key": identity.memberKey },
    body: JSON.stringify({ revision: 0, items: [{ sku: "1440", quantity: 1 }] }),
  });
  const addresses = await fetch(`${origin}/api/addresses`, {
    headers: { "X-Organizer-Key": KEY },
  });
  // Then
  assert.equal(page.status, 200);
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).me.submitted, true);
  assert.equal(addresses.status, 403);
  await Promise.all([page, addresses].map((response) => response.body?.cancel()));
});
