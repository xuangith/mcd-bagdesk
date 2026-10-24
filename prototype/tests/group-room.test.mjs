import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture, readyOrder } from "./group-fixture.mjs";
import { memberView, makeDesk } from "../room.mjs";
import { summarize, restoreDesk } from "../state.mjs";
import { menuGroup } from "../catalog.mjs";

test("member wishes accept only real individual products, not package codes", async (t) => {
  // Given
  const { service, room } = await fixture(t);
  const member = await service.join(room.id, { name: "成员" });
  // When / Then
  await assert.rejects(service.wishes(room.id, member.member.id, {
    revision: 0, items: [{ sku: "9900005456", quantity: 1 }],
  }), { code: "INVALID_WISHES" });
  assert.equal(service.room(room.id).members[0].submitted, false);
});

test("stale member revisions cannot overwrite a newer wish list", async (t) => {
  // Given
  const { service, room } = await fixture(t);
  const member = await service.join(room.id, { name: "成员" });
  await service.wishes(room.id, member.member.id, { revision: 0, items: [{ sku: "1440", quantity: 1 }] });
  // When / Then
  await assert.rejects(service.wishes(room.id, member.member.id, {
    revision: 0, items: [{ sku: "4810", quantity: 1 }],
  }), { code: "STALE_WISHES" });
  assert.deepEqual(service.room(room.id).members[0].wishes, [{ sku: "1440", quantity: 1 }]);
});

test("locking waits for joined members and permits an explicit no-meal submission", async (t) => {
  // Given
  const { service, room } = await fixture(t);
  const member = await service.join(room.id, { name: "成员" });
  // When / Then
  await assert.rejects(service.plan(room.id, service.room(room.id).version), { code: "WAITING_MEMBERS" });
  await service.wishes(room.id, member.member.id, { revision: 0, items: [] });
  assert.equal(service.room(room.id).members[0].submitted, true);
  await assert.rejects(service.plan(room.id, service.room(room.id).version), { code: "EMPTY_DEMAND" });
});

test("plans compare official full-cart prices and retain useful unassigned extras", async (t) => {
  // Given / When
  const { room, plan } = await readyOrder(t);
  // Then
  assert.equal(room.phase, "confirmed");
  assert.equal(plan.quote.priceCents, 6700);
  assert.ok(room.plans.some((item) => item.items.every((product) => !product.roundList)));
  const desk = makeDesk(room, plan);
  assert.equal(summarize(desk).expectedTotal, 6);
  assert.equal(desk.people.length, 2);
  assert.equal(desk.people.flatMap((person) => person.wants).reduce((sum, item) => sum + item.quantity, 0), 4);
  assert.equal(plan.extras.reduce((sum, item) => sum + item.quantity, 0), 2);
});

test("after collection closes, old mobile pages cannot modify paid-order intentions", async (t) => {
  // Given
  const { service, room, members } = await readyOrder(t);
  // When / Then
  await assert.rejects(service.wishes(room.id, members[0].id, {
    revision: 1, items: [{ sku: "3505", quantity: 1 }],
  }), { code: "ROOM_LOCKED" });
  const reopened = await service.reopen(room.id, room.version);
  assert.equal(reopened.phase, "collecting");
  assert.deepEqual(reopened.plans, []);
  assert.equal(reopened.confirmation, null);
});

test("member views do not expose another member, payment or credential fields", async (t) => {
  // Given
  const { room, members } = await readyOrder(t);
  const poisoned = {
    ...room, paymentUrl: "SECRET_PAYMENT_URL", token: "SECRET_MCP",
    order: { orderId: "SECRET_ORDER", phone: "SECRET_PHONE" },
  };
  // When
  const view = memberView(poisoned, members[0]);
  // Then
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("SECRET_"), false);
  assert.equal(serialized.includes(members[1].name), false);
  assert.equal(serialized.includes("keyHash"), false);
  assert.equal(view.menu.some((item) => item.sku === "9900005456"), false);
});

test("menu groups prioritize specific live categories over hot-sale categories", () => {
  // Given / When / Then
  assert.equal(menuGroup("猪柳蛋麦满分", ["人气热卖", "麦满分系列"]), "burger");
  assert.equal(menuGroup("麦乐鸡", ["小食甜品/其他"]), "snack");
  assert.equal(menuGroup("可乐中杯", ["饮品"]), "drink");
  assert.equal(menuGroup("香芋派", ["小食甜品/其他"]), "dessert");
  assert.equal(menuGroup("未知餐品", ["人气热卖"]), "other");
});

test("room records are private and do not persist payment links or raw credential payloads", async (t) => {
  // Given
  const { room, service, directory } = await readyOrder(t);
  service.paymentUrls.set(room.id, "SECRET_URL");
  await service.save(room, { payH5Url: "SECRET_LINK", token: "SECRET_TOKEN", mobilePhone: "SECRET_PHONE" });
  // When
  const path = join(directory, `${room.id}.json`);
  const saved = await readFile(path, "utf8");
  // Then
  assert.equal(saved.includes("SECRET_"), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("restoring a desk preserves counts and undo history while rejecting impossible stock", async (t) => {
  // Given
  const { room, plan } = await readyOrder(t);
  const desk = makeDesk(room, plan);
  // When
  const restored = restoreDesk(JSON.parse(JSON.stringify(desk)));
  // Then
  assert.deepEqual(restored, desk);
  const first = desk.people[0];
  const invalid = structuredClone(desk);
  invalid.claims[first.id] = true;
  assert.throws(() => restoreDesk(invalid), { code: "INVALID_SNAPSHOT" });
});
