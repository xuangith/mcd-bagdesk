import test from "node:test";
import assert from "node:assert/strict";
import { createDesk, reduceDesk, summarize } from "../state.mjs";
import { demoOrder } from "../sample.mjs";

function receivedDemo(overrides = {}) {
  return demoOrder.items.reduce((state, item) => reduceDesk(state, {
    type: "receive", itemId: item.id, quantity: overrides[item.id] ?? item.expected,
  }), createDesk(demoOrder));
}

test("unknown counts remain unknown rather than becoming shortages of zero", () => {
  // Given
  const state = createDesk(demoOrder);
  // When
  const result = summarize(state);
  // Then
  assert.equal(result.expectedTotal, 36);
  assert.equal(result.totalPeople, 12);
  assert.equal(result.pendingKinds, 4);
  assert.equal(result.receiptComplete, false);
  assert.ok(result.rows.every((row) =>
    row.received === null && row.remaining === null && row.shortage === null));
});

test("a confirmed zero is a real shortage", () => {
  // Given
  const state = createDesk(demoOrder);
  // When
  const result = summarize(reduceDesk(state, { type: "receive", itemId: "fries", quantity: 0 }));
  // Then
  assert.equal(result.rows.find((row) => row.id === "fries").shortage, 12);
  assert.equal(result.pendingKinds, 3);
});

test("confirmed extra food is shown separately from a matched receipt", () => {
  // Given / When
  const result = summarize(receivedDemo({ fries: 13 }));
  // Then
  assert.equal(result.receivedTotal, 37);
  assert.equal(result.overageTotal, 1);
  assert.equal(result.receiptComplete, false);
});

test("receiving everything completes verification without claiming any meal", () => {
  // Given / When
  const result = summarize(receivedDemo());
  // Then
  assert.equal(result.receiptComplete, true);
  assert.equal(result.claimedTotal, 0);
  assert.equal(result.claimedPeople, 0);
});

test("an uncounted meal cannot be handed out", () => {
  // Given / When / Then
  assert.throws(() => reduceDesk(createDesk(demoOrder), { type: "claim", personId: "p1" }),
    { code: "UNCOUNTED" });
});

test("one missing fries prevents the twelfth handoff without losing other stock", () => {
  // Given
  let state = receivedDemo({ fries: 11 });
  for (const person of state.people.slice(0, 11)) {
    state = reduceDesk(state, { type: "claim", personId: person.id });
  }
  const before = JSON.stringify(state);
  // When / Then
  assert.throws(() => reduceDesk(state, { type: "claim", personId: "p12" }),
    { code: "INSUFFICIENT_STOCK" });
  assert.equal(JSON.stringify(state), before);
  assert.equal(summarize(state).claimedTotal, 33);
  assert.equal(summarize(state).rows.find((row) => row.id === "burger").remaining, 1);
});

test("one person cannot receive twice", () => {
  // Given
  const state = reduceDesk(receivedDemo(), { type: "claim", personId: "p1" });
  // When / Then
  assert.throws(() => reduceDesk(state, { type: "claim", personId: "p1" }),
    { code: "ALREADY_CLAIMED" });
  assert.equal(summarize(state).claimedTotal, 3);
});

test("returning a meal restores precisely that person's stock", () => {
  // Given
  const claimed = reduceDesk(receivedDemo(), { type: "claim", personId: "p1" });
  // When
  const state = reduceDesk(claimed, { type: "return", personId: "p1" });
  // Then
  assert.equal(summarize(state).claimedTotal, 0);
  assert.deepEqual(summarize(state).rows.map((row) => row.remaining), [12, 12, 8, 4]);
});

test("an unclaimed meal cannot be returned", () => {
  // Given / When / Then
  assert.throws(() => reduceDesk(receivedDemo(), { type: "return", personId: "p1" }),
    { code: "NOT_CLAIMED" });
});

test("received food cannot be corrected below food already handed out", () => {
  // Given
  const state = reduceDesk(receivedDemo(), { type: "claim", personId: "p1" });
  // When / Then
  assert.throws(() => reduceDesk(state, { type: "receive", itemId: "burger", quantity: 0 }),
    { code: "ALREADY_DISTRIBUTED" });
  assert.throws(() => reduceDesk(state, { type: "receive", itemId: "burger", quantity: null }),
    { code: "ALREADY_DISTRIBUTED" });
});

test("undo restores a prior handoff and then a prior count", () => {
  // Given
  const counted = receivedDemo();
  const claimed = reduceDesk(counted, { type: "claim", personId: "p1" });
  // When
  const restored = reduceDesk(claimed, { type: "undo" });
  // Then
  assert.deepEqual(restored, counted);
  const priorCount = reduceDesk(restored, { type: "undo" });
  assert.equal(priorCount.received.tea, null);
  assert.equal(summarize(priorCount).pendingKinds, 1);
});

test("undo with no history fails explicitly", () => {
  // Given / When / Then
  assert.throws(() => reduceDesk(createDesk(demoOrder), { type: "undo" }),
    { code: "NOTHING_TO_UNDO" });
});

test("all twelve handoffs conserve all thirty-six pieces", () => {
  // Given
  let state = receivedDemo();
  // When
  for (const person of state.people) state = reduceDesk(state, { type: "claim", personId: person.id });
  // Then
  const result = summarize(state);
  assert.equal(result.claimedTotal, 36);
  assert.equal(result.claimedPeople, 12);
  assert.ok(result.rows.every((row) => row.remaining === 0));
});

test("new people cannot allocate more than the order contains", () => {
  // Given
  const base = createDesk({ ...demoOrder, people: [] });
  const one = reduceDesk(base, { type: "addPerson", name: "同事", wants: [{ itemId: "tea", quantity: 4 }] });
  // When / Then
  assert.throws(() => reduceDesk(one, {
    type: "addPerson", name: "另一位", wants: [{ itemId: "tea", quantity: 1 }],
  }), { code: "DEMAND_EXCEEDS_ORDER" });
  assert.equal(one.people.length, 1);
});

test("reducers do not mutate the fixture or earlier state", () => {
  // Given
  const fixture = JSON.stringify(demoOrder);
  const initial = createDesk(demoOrder);
  const before = JSON.stringify(initial);
  // When
  reduceDesk(initial, { type: "receive", itemId: "burger", quantity: 12 });
  // Then
  assert.equal(JSON.stringify(initial), before);
  assert.equal(JSON.stringify(demoOrder), fixture);
});

test("invalid counts and unknown actions are rejected", () => {
  // Given
  const state = createDesk(demoOrder);
  // When / Then
  for (const quantity of [-1, 1.5, "12", 1000, NaN]) {
    assert.throws(() => reduceDesk(state, { type: "receive", itemId: "burger", quantity }),
      { code: "INVALID_QUANTITY" });
  }
  assert.throws(() => reduceDesk(state, { type: "missing" }), { code: "INVALID_ACTION" });
});

test("a batch receipt is one undoable action even after history reaches its limit", () => {
  // Given
  let state = createDesk(demoOrder);
  for (let i = 0; i < 65; i += 1) {
    state = reduceDesk(state, { type: "receive", itemId: "burger", quantity: i % 2 });
  }
  const before = { ...state, history: state.history.slice(1) };
  // When
  const counted = reduceDesk(state, {
    type: "receiveMany",
    counts: state.items.map((item) => ({ itemId: item.id, quantity: item.expected })),
  });
  // Then
  assert.equal(counted.history.length, 60);
  assert.equal(summarize(counted).receiptComplete, true);
  assert.deepEqual(reduceDesk(counted, { type: "undo" }), before);
});

test("a failed batch cannot partially confirm receipt", () => {
  // Given
  const state = createDesk(demoOrder);
  const before = JSON.stringify(state);
  // When / Then
  assert.throws(() => reduceDesk(state, {
    type: "receiveMany", counts: [
      { itemId: "burger", quantity: 12 }, { itemId: "fries", quantity: -1 },
    ],
  }), { code: "INVALID_QUANTITY" });
  assert.equal(JSON.stringify(state), before);
});

test("reconfirming the same count does not add an undo step", () => {
  // Given
  const state = reduceDesk(createDesk(demoOrder), { type: "receive", itemId: "burger", quantity: 12 });
  // When
  const same = reduceDesk(state, { type: "receive", itemId: "burger", quantity: 12 });
  // Then
  assert.equal(same, state);
  assert.equal(reduceDesk(same, { type: "undo" }).received.burger, null);
});
