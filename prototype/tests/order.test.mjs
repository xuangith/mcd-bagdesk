import test from "node:test";
import assert from "node:assert/strict";
import { inspectOrder, resolveOrder } from "../order.mjs";
import { createDesk } from "../state.mjs";
import { rawDemoOrder } from "../sample.mjs";

function decisionsFor(inspection, scope = "per-package") {
  return inspection.lines.map((line) => ({
    lineId: line.id, scope: line.children.length ? scope : "per-package",
    children: (line.children.length ? line.children : [{ name: line.name, quantity: 1 }])
      .map((child) => ({
        ...child, include: child.name !== "不要冰",
        category: child.name.includes("汉堡") ? "burger" :
          child.name.includes("薯条") ? "fries" : "drink",
      })),
  }));
}

test("inspection keeps only food-description fields", () => {
  // Given
  const raw = {
    ...rawDemoOrder,
    token: "secret-token",
    data: {
      ...rawDemoOrder.data,
      orderId: "secret-order", pickupCode: "secret-pickup",
      deliveryInfo: { mobilePhone: "secret-phone", addressDetail: "secret-address" },
    },
  };
  // When
  const inspection = inspectOrder(raw);
  // Then
  assert.equal(inspection.lines.length, 2);
  assert.equal(JSON.stringify(inspection).includes("secret"), false);
});

test("per-package counts multiply by the parent quantity", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  // When
  const order = resolveOrder(inspection, decisionsFor(inspection));
  // Then
  assert.deepEqual(order.items.map((item) => item.expected), [4, 4, 4, 2]);
  assert.equal(order.source, "imported");
  assert.deepEqual(order.people, []);
  assert.equal(createDesk(order).received["food-1"], null);
});

test("line-total counts are not multiplied a second time", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  // When
  const order = resolveOrder(inspection, decisionsFor(inspection, "line-total"));
  // Then
  assert.deepEqual(order.items.map((item) => item.expected), [2, 2, 2, 2]);
});

test("scope must be chosen explicitly for each package", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  const decisions = decisionsFor(inspection);
  delete decisions[0].scope;
  // When / Then
  assert.throws(() => resolveOrder(inspection, decisions), { code: "MISSING_SCOPE" });
});

test("every child requires an explicit include or ignore decision", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  const decisions = decisionsFor(inspection);
  delete decisions[0].children[3].include;
  // When / Then
  assert.throws(() => resolveOrder(inspection, decisions), { code: "UNCONFIRMED_CHILD" });
});

test("instructions are excluded only when a user decision excludes them", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  const decisions = decisionsFor(inspection);
  decisions[0].children[3].include = true;
  decisions[0].children[3].category = "other";
  // When
  const order = resolveOrder(inspection, decisions);
  // Then
  assert.ok(order.items.some((item) => item.name === "不要冰" && item.expected === 2));
});

test("changed child names or quantities cannot bypass the confirmation step", () => {
  // Given
  const inspection = inspectOrder(rawDemoOrder);
  const decisions = decisionsFor(inspection);
  decisions[0].children[0].quantity = 99;
  // When / Then
  assert.throws(() => resolveOrder(inspection, decisions), { code: "UNCONFIRMED_CHILD" });
});

test("unknown or malformed upstream counts are not silently turned into zero", () => {
  // Given / When / Then
  for (const quantity of [undefined, "2", -1, 0, 1.5, 1000]) {
    assert.throws(() => inspectOrder({
      orderProductList: [{ productName: "套餐", quantity }],
    }), { code: "INVALID_PRODUCT" });
  }
});

test("error envelopes and missing product lists are rejected", () => {
  // Given / When / Then
  assert.throws(() => inspectOrder({ code: 401, data: rawDemoOrder.data }), { code: "INVALID_ORDER" });
  assert.throws(() => inspectOrder({ data: {} }), { code: "INVALID_PRODUCTS" });
});

test("duplicate foods merge while category conflicts require correction", () => {
  // Given
  const inspection = inspectOrder({
    orderProductList: [
      { productName: "可乐", quantity: 2 },
      { productName: "可乐", quantity: 3 },
    ],
  });
  const decisions = decisionsFor(inspection);
  // When
  const order = resolveOrder(inspection, decisions);
  // Then
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].expected, 5);
  decisions[1].children[0].category = "other";
  assert.throws(() => resolveOrder(inspection, decisions), { code: "CATEGORY_CONFLICT" });
});
