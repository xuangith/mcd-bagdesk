import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./group-fixture.mjs";
import { addressFingerprint } from "../fulfillment.mjs";
import { memberView } from "../room.mjs";
import { quoteArgs } from "../quotes.mjs";

async function readyDelivery(t) {
  const context = await fixture(t);
  const { service, gateway } = context;
  const calls = [];
  const original = gateway.call.bind(gateway);
  gateway.call = async (name, args) => { calls.push({ name, args: structuredClone(args) }); return original(name, args); };
  const addresses = await service.directory.loadAddresses();
  const stores = await service.directory.delivery(addresses[0].addressId);
  const created = await service.create({ title: "配送合成测试", storeCode: stores[0].selectionKey });
  const joined = await service.join(created.room.id, { name: "配送成员" });
  await service.wishes(created.room.id, joined.member.id, {
    revision: 0, items: [{ sku: "1440", quantity: 1 }],
  });
  const planned = await service.plan(created.room.id, service.room(created.room.id).version);
  const addressHash = addressFingerprint(service.directory.addresses.get("demo-address"));
  const confirmed = await service.select(planned.id, {
    version: planned.version, planId: planned.plans[0].id, takeWayCode: "", addressHash,
  });
  return { ...context, ...confirmed, calls };
}

test("delivery uses paired business codes for menu and pricing, and keeps fees in the final amount", async (t) => {
  // Given / When
  const context = await readyDelivery(t);
  // Then
  assert.equal(context.room.fulfillment.mode, "delivery");
  const plan = context.room.plans.find((item) => item.id === context.room.confirmation.planId);
  assert.equal(plan.quote.deliveryCents, 900);
  assert.equal(plan.quote.priceCents, 3150);
  for (const call of context.calls.filter((item) => ["query-meals", "query-meal-detail", "calculate-price"].includes(item.name))) {
    assert.equal(call.args.beType, 2);
    assert.equal(call.args.orderType, 2);
    assert.equal(call.args.beCode, "demo-delivery-code");
  }
});

test("delivery creation uses the verified address and omits pickup takeWayCode", async (t) => {
  // Given
  const context = await readyDelivery(t);
  // When
  const created = await context.service.order(context.room.id, {
    version: context.room.version, nonce: context.nonce, confirmed: true,
  });
  // Then
  const createCall = context.calls.find((call) => call.name === "create-order");
  assert.equal(createCall.args.addressId, "demo-address");
  assert.equal(createCall.args.beCode, "demo-delivery-code");
  assert.equal(Object.hasOwn(createCall.args, "takeWayCode"), false);
  assert.equal(created.phase, "awaiting-payment");
});

test("changed delivery contact details invalidate confirmation before creating an order", async (t) => {
  // Given
  const context = await readyDelivery(t);
  const original = context.gateway.call.bind(context.gateway);
  context.gateway.call = async (name, args) => {
    const result = await original(name, args);
    if (name === "delivery-query-addresses") result.addresses[0].fullAddress = "已变化的合成地址";
    return result;
  };
  // When / Then
  await assert.rejects(context.service.order(context.room.id, {
    version: context.room.version, nonce: context.nonce, confirmed: true,
  }), { code: "ADDRESS_CHANGED" });
  assert.equal(context.gateway.createCalls, 0);
});

test("members and stored room records never receive contact details", async (t) => {
  // Given
  const context = await readyDelivery(t);
  const own = context.room.members[0];
  // When
  const publicText = JSON.stringify(memberView(context.room, own));
  const stored = await readFile(join(context.directory, `${context.room.id}.json`), "utf8");
  // Then
  for (const value of ["13800000000", "合成演示路1号", "演示收件人", "demo-delivery-code", "demo-address"]) {
    assert.equal(publicText.includes(value), false);
  }
  for (const value of ["13800000000", "合成演示路1号", "演示收件人"]) {
    assert.equal(stored.includes(value), false);
  }
});

test("pickup requests do not inherit an address or delivery business code", () => {
  // Given / When
  const args = quoteArgs({ store: { storeCode: "123" }, fulfillment: { mode: "pickup" } }, []);
  // Then
  assert.deepEqual(args, { storeCode: "123", orderType: 1, beType: 1, items: [] });
});
