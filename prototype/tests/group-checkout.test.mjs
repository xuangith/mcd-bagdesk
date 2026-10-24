import test from "node:test";
import assert from "node:assert/strict";
import { readyOrder } from "./group-fixture.mjs";
import { GroupService } from "../group-service.mjs";
import { GatewayError } from "../mcp-gateway.mjs";
import { summarize } from "../state.mjs";
import { randomUUID } from "node:crypto";

const createInput = (context) => ({
  version: context.service.room(context.room.id).version, nonce: context.nonce, confirmed: true,
});

test("pending and cancelled official orders never enter the bag desk", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  // When
  const pending = await context.service.verify(created.id);
  // Then
  assert.equal(pending.phase, "awaiting-payment");
  assert.throws(() => context.service.desk(created.id), { code: "PAID_REQUIRED" });
  context.gateway.orders.get(created.order.orderId).orderStatus = "7";
  const cancelled = await context.service.verify(created.id);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.desk, null);
});

test("official paid verification intakes once and persists manual distribution", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  context.gateway.markDemoPaid(created.order.orderId);
  // When
  const paid = await context.service.verify(created.id);
  // Then
  assert.equal(paid.phase, "intaken");
  assert.equal(paid.review.verifiedPaid, true);
  assert.equal(summarize(paid.desk).expectedTotal, 6);
  const again = await context.service.verify(created.id);
  assert.equal(again.version, paid.version);
  let updated = context.service.desk(created.id);
  for (const item of updated.desk.items) updated = await context.service.deskAction(created.id, {
    deskVersion: updated.deskVersion,
    action: { type: "receive", itemId: item.id, quantity: item.expected },
  });
  updated = await context.service.deskAction(created.id, {
    deskVersion: updated.deskVersion, action: { type: "claim", personId: paid.desk.people[0].id },
  });
  const restarted = new GroupService(context.gateway, context.store);
  await restarted.initialize();
  assert.equal(summarize(restarted.desk(created.id).desk).claimedPeople, 1);
  assert.equal(context.gateway.createCalls, 1);
});

test("a new price invalidates confirmation before any order creation", async (t) => {
  // Given
  const context = await readyOrder(t);
  const call = context.gateway.call.bind(context.gateway);
  context.gateway.call = async (name, args) => {
    const result = await call(name, args);
    return name === "calculate-price" ? { ...result, price: result.price + 100 } : result;
  };
  // When / Then
  await assert.rejects(context.service.order(context.room.id, createInput(context)), { code: "PRICE_CHANGED" });
  assert.equal(context.gateway.createCalls, 0);
  assert.equal(context.service.room(context.room.id).phase, "planned");
});

test("simultaneous confirm clicks call the external create tool exactly once", { timeout: 3000 }, async (t) => {
  // Given: subscribe to the exact create call before triggering it.
  const context = await readyOrder(t);
  const call = context.gateway.call.bind(context.gateway);
  let signal, release;
  const started = new Promise((resolve) => { signal = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  context.gateway.call = async (name, args) => {
    if (name === "create-order") { signal(); await held; }
    return call(name, args);
  };
  const input = createInput(context);
  // When
  const first = context.service.order(context.room.id, input);
  await started;
  // Then
  await assert.rejects(context.service.order(context.room.id, input), { code: "ROOM_BUSY" });
  release();
  await first;
  assert.equal(context.gateway.createCalls, 1);
});

test("unknown create outcomes are not automatically retried", async (t) => {
  // Given
  const context = await readyOrder(t);
  const call = context.gateway.call.bind(context.gateway);
  let attempts = 0;
  context.gateway.call = async (name, args) => {
    if (name === "create-order") { attempts += 1; throw new GatewayError("MCP_CONNECTION", "synthetic", true); }
    return call(name, args);
  };
  // When / Then
  await assert.rejects(context.service.order(context.room.id, createInput(context)), { code: "CREATE_NOT_COMPLETED" });
  assert.equal(context.service.room(context.room.id).phase, "creation-unknown");
  await assert.rejects(context.service.order(context.room.id, createInput(context)), { code: "CONFIRMATION_REQUIRED" });
  assert.equal(attempts, 1);
});

test("the create marker is on disk before the external write and survives a later storage failure", async (t) => {
  // Given
  const context = await readyOrder(t);
  const call = context.gateway.call.bind(context.gateway);
  context.gateway.call = async (name, args) => {
    if (name === "create-order") {
      const stored = (await context.store.readAll()).find((room) => room.id === context.room.id);
      assert.equal(stored.phase, "creating");
    }
    return call(name, args);
  };
  const write = context.store.write.bind(context.store);
  context.store.write = async (room) => {
    if (room.phase === "awaiting-payment") throw new Error("synthetic disk failure");
    return write(room);
  };
  // When / Then
  await assert.rejects(context.service.order(context.room.id, createInput(context)), { code: "ORDER_STORAGE" });
  context.store.write = write;
  const restarted = new GroupService(context.gateway, context.store);
  await restarted.initialize();
  assert.equal(restarted.room(context.room.id).phase, "creation-unknown");
  assert.equal(context.gateway.createCalls, 1);
  await assert.rejects(restarted.order(context.room.id, {
    version: restarted.room(context.room.id).version, nonce: context.nonce, confirmed: true,
  }), { code: "CONFIRMATION_REQUIRED" });
});

test("a paid response with different food is held for review, never silently intaken", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  const upstream = context.gateway.orders.get(created.order.orderId);
  upstream.orderStatus = "2";
  upstream.orderProductList[0].quantity += 1;
  // When
  const result = await context.service.verify(created.id);
  // Then
  assert.equal(result.phase, "paid-review");
  assert.equal(result.desk, null);
});

test("a paid response from a different store is held for review", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  const upstream = context.gateway.orders.get(created.order.orderId);
  upstream.orderStatus = "2";
  upstream.storeName = "另一家合成餐厅";
  // When
  const result = await context.service.verify(created.id);
  // Then
  assert.equal(result.phase, "paid-review");
  assert.equal(result.desk, null);
});

test("changed or missing package choices cannot be silently assigned to members", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  const upstream = context.gateway.orders.get(created.order.orderId);
  upstream.orderStatus = "2";
  upstream.orderProductList[0].comboItemList[0].itemName = "另一个汉堡";
  // When
  const result = await context.service.verify(created.id);
  // Then
  assert.equal(result.phase, "paid-review");
  assert.equal(result.desk, null);
});

test("an official order cannot be recovered into a second room, including after restart", async (t) => {
  // Given
  const context = await readyOrder(t);
  const created = await context.service.order(context.room.id, createInput(context));
  context.gateway.markDemoPaid(created.order.orderId);
  await context.service.verify(created.id);
  const second = {
    ...structuredClone(context.room), id: randomUUID(), phase: "creation-unknown",
    attempt: { startedAt: created.attempt.startedAt }, order: null, desk: null,
  };
  await context.store.write(second);
  context.service.rooms.set(second.id, second);
  // When / Then
  await assert.rejects(context.service.recover(second.id, {
    version: second.version, orderId: created.order.orderId,
  }), { code: "ORDER_ALREADY_LINKED" });
  const restarted = new GroupService(context.gateway, context.store);
  await restarted.initialize();
  await assert.rejects(restarted.recover(second.id, {
    version: second.version, orderId: created.order.orderId,
  }), { code: "ORDER_ALREADY_LINKED" });
  assert.equal(restarted.room(second.id).desk, null);
});

test("concurrent recovery of one external order succeeds in only one room", async (t) => {
  // Given
  const context = await readyOrder(t);
  const external = await context.gateway.call("create-order", {
    items: context.plan.items, storeCode: "900001", orderType: 1, beType: 1, takeWayCode: "take-in-store",
  });
  context.gateway.markDemoPaid(external.orderId);
  const rooms = [0, 1].map(() => ({
    ...structuredClone(context.room), id: randomUUID(), phase: "creation-unknown",
    attempt: { startedAt: new Date().toISOString() }, order: null, desk: null,
  }));
  for (const room of rooms) { await context.store.write(room); context.service.rooms.set(room.id, room); }
  // When
  const results = await Promise.allSettled(rooms.map((room) =>
    context.service.recover(room.id, { version: room.version, orderId: external.orderId })));
  // Then
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "ORDER_ALREADY_LINKED");
  assert.equal(rooms.filter((room) => context.service.room(room.id).phase === "intaken").length, 1);
});
