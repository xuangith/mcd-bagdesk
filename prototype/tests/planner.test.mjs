import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlans, PlanningError } from '../planner.mjs';

const offer = (id, estimatedCents, contents, requestItem) => ({
  id, name: id, estimatedCents,
  components: Object.entries(contents).map(([sku, quantity]) => ({ sku, quantity, name: sku, category: 'food' })),
  requestItem: requestItem ?? { productCode: id, quantity: 1 },
});
const demand = contents => Object.entries(contents).map(([sku, quantity]) => ({ sku, quantity }));
const sorted = map => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const add = (map, sku, quantity) => map.set(sku, (map.get(sku) ?? 0) + quantity);

function verify(input, result) {
  const wanted = new Map(), signatures = new Set();
  input.demand.forEach(row => add(wanted, row.sku, row.quantity));
  assert.ok(result.plans.length <= (input.limit ?? 8));
  assert.ok(result.search.states <= (input.maxStates ?? 20000));
  assert.equal(result.search.priceBasis, 'catalog-estimate');
  result.plans.forEach((plan, index) => {
    assert.equal(plan.id, `plan-${index + 1}`);
    const actual = new Map(), split = new Map();
    let cost = 0;
    plan.usedOffers.forEach((used, i) => {
      const source = input.offers.find(row => row.id === used.offerId);
      assert.ok(Number.isSafeInteger(used.quantity) && used.quantity > 0);
      cost += source.estimatedCents * used.quantity;
      source.components.forEach(row => add(actual, row.sku, row.quantity * used.quantity));
      assert.deepEqual(plan.items[i], { ...source.requestItem, quantity: used.quantity });
    });
    assert.equal(plan.items.length, plan.usedOffers.length);
    assert.equal(plan.estimatedCents, cost);
    assert.deepEqual(sorted(new Map(plan.components.map(row => [row.sku, row.quantity]))), sorted(wanted));
    for (const row of [...plan.components, ...plan.extras]) {
      assert.ok(Number.isSafeInteger(row.quantity) && row.quantity > 0);
      add(split, row.sku, row.quantity);
    }
    assert.deepEqual(sorted(split), sorted(actual));
    const key = JSON.stringify(plan.usedOffers);
    assert.ok(!signatures.has(key));
    signatures.add(key);
  });
}

function bruteMinimum(input) {
  const wanted = new Map(input.demand.map(row => [row.sku, row.quantity]));
  const total = input.demand.reduce((sum, row) => sum + row.quantity, 0);
  let minimum = Infinity;
  function enumerate(index, cost, contents) {
    if (index === input.offers.length) {
      if ([...wanted].every(([sku, quantity]) => (contents.get(sku) ?? 0) >= quantity)) minimum = Math.min(minimum, cost);
      return;
    }
    const source = input.offers[index];
    for (let quantity = 0; quantity <= total; quantity++) {
      const next = new Map(contents);
      source.components.forEach(row => add(next, row.sku, row.quantity * quantity));
      enumerate(index + 1, cost + source.estimatedCents * quantity, next);
    }
  }
  enumerate(0, 0, new Map());
  return minimum;
}

test('finds the estimated optimum that a cheapest-coverage greedy choice misses', () => {
  const input = { demand: demand({ A: 1, B: 1, C: 1 }), limit: 12, offers: [
    offer('ab', 4, { A: 1, B: 1 }), offer('ac', 5, { A: 1, C: 1 }),
    offer('a', 4, { A: 1 }), offer('b', 3, { B: 1 }), offer('c', 5, { C: 1 }),
  ] };
  const remaining = new Map(input.demand.map(row => [row.sku, row.quantity]));
  let greedyCost = 0;
  while ([...remaining.values()].some(quantity => quantity > 0)) {
    const choices = input.offers.map(source => ({ source, coverage: source.components.reduce(
      (sum, row) => sum + Math.min(remaining.get(row.sku) ?? 0, row.quantity), 0) }))
      .filter(row => row.coverage).sort((a, b) => a.source.estimatedCents / a.coverage - b.source.estimatedCents / b.coverage);
    const chosen = choices[0].source;
    greedyCost += chosen.estimatedCents;
    chosen.components.forEach(row => remaining.set(row.sku, Math.max(0, (remaining.get(row.sku) ?? 0) - row.quantity)));
  }
  const result = buildPlans(input);
  verify(input, result);
  assert.equal(greedyCost, 9);
  assert.equal(bruteMinimum(input), 8);
  assert.equal(result.plans[0].estimatedCents, 8);
  assert.deepEqual(result.plans[0].usedOffers, [{ offerId: 'ac', quantity: 1 }, { offerId: 'b', quantity: 1 }]);
  assert.ok(result.plans.some(plan => plan.estimatedCents === 12 && plan.usedOffers.length === 3));
  assert.equal(result.search.truncated, false);
});

test('sorts exact cover ahead of equal-price extras and never substitutes by name', () => {
  const input = { demand: demand({ A: 1 }), offers: [
    offer('a-extra', 100, { A: 2, B: 1 }), offer('z-exact', 100, { A: 1 }),
    { ...offer('wrong-sku', 0, { Z: 1 }), name: 'A' },
  ] };
  const result = buildPlans(input);
  verify(input, result);
  assert.deepEqual(result.plans.map(plan => plan.usedOffers[0].offerId), ['z-exact', 'a-extra']);
  assert.deepEqual(result.plans[0].extras, []);
  assert.deepEqual(result.plans[1].extras.map(({ sku, quantity }) => ({ sku, quantity })), demand({ A: 1, B: 1 }));
});

test('deduplicates offer multisets reached in different orders with stable output', () => {
  const input = { demand: demand({ A: 2, B: 1 }), limit: 12, offers: [
    offer('x', 1, { A: 1 }), offer('y', 2, { A: 1, B: 1 }),
  ] };
  const result = buildPlans(input);
  verify(input, result);
  assert.equal(result.plans.filter(plan => JSON.stringify(plan.usedOffers) === JSON.stringify([
    { offerId: 'x', quantity: 1 }, { offerId: 'y', quantity: 1 },
  ])).length, 1);
  assert.deepEqual(buildPlans({ ...input, demand: [...input.demand].reverse(), offers: [...input.offers].reverse() }), result);
  assert.deepEqual(buildPlans(input), result);
});

test('uses a stable offer signature as the final tie breaker', () => {
  const input = { demand: demand({ A: 1 }), offers: [
    offer('z', 0, { A: 1 }), offer('a', 0, { A: 1 }),
  ] };
  assert.deepEqual(buildPlans(input).plans.map(plan => plan.usedOffers[0].offerId), ['a', 'z']);
});

test('never emits a partial cover or a name-based replacement when no solution exists', () => {
  for (const offers of [[], [offer('a', 1, { A: 1 })], [{ ...offer('z', 0, { Z: 1 }), name: 'B' }]]) {
    const input = { demand: demand({ A: 1, B: 1 }), offers };
    const result = buildPlans(input);
    assert.deepEqual(result.plans, []);
    assert.equal(result.search.truncated, false);
  }
});

test('aggregates duplicate demand rows and component rows by exact SKU', () => {
  const source = offer('same', 0, { A: 1 });
  source.components.push({ ...source.components[0] });
  const input = { demand: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 1 }], offers: [source] };
  const result = buildPlans(input);
  verify(input, result);
  assert.equal(result.plans[0].estimatedCents, 0);
  assert.deepEqual(result.plans[0].usedOffers, [{ offerId: 'same', quantity: 1 }]);
});

test('preserves frozen inputs and the exact source roundList when increasing quantities', () => {
  const requestItem = { productCode: '9900005456', quantity: 1, roundList: [
    { round: 'real-round', comboItemList: [{ code: 'actual-choice', quantity: 1 }], extra: { selected: true } },
  ] };
  const input = { demand: demand({ A: 2 }), offers: [offer('combo', 11, { A: 1, B: 1 }, requestItem)] };
  const snapshot = structuredClone(input);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(input);
  const result = buildPlans(input);
  verify(input, result);
  assert.deepEqual(input, snapshot);
  assert.equal(result.plans[0].items[0].quantity, 2);
  assert.deepEqual(result.plans[0].items[0].roundList, requestItem.roundList);
  result.plans[0].items[0].roundList[0].comboItemList[0].code = 'changed-output';
  assert.deepEqual(input, snapshot);
  assert.deepEqual(buildPlans(input).plans[0].items[0].roundList, requestItem.roundList);
});

test('retains the direct-single baseline outside the state budget and candidate cutoff', () => {
  const input = { demand: demand({ A: 1, B: 1 }), limit: 2, offers: [
    offer('a', 10, { A: 1 }), offer('b', 10, { B: 1 }),
    offer('combo-c', 1, { A: 1, B: 1 }), offer('combo-d', 2, { A: 1, B: 1 }),
    offer('combo-e', 3, { A: 1, B: 1 }),
  ] };
  const bounded = buildPlans({ ...input, maxStates: 1 });
  verify(input, bounded);
  assert.deepEqual(bounded.search, { states: 1, truncated: true, priceBasis: 'catalog-estimate' });
  assert.deepEqual(bounded.plans.map(plan => plan.estimatedCents), [1, 20]);
  const complete = buildPlans(input);
  verify(input, complete);
  assert.deepEqual(complete.plans.map(plan => plan.estimatedCents), [1, 20]);
  assert.equal(complete.search.truncated, false);
  assert.deepEqual(buildPlans({ ...input, limit: 1 }).plans.map(plan => plan.estimatedCents), [20]);
  const withoutBaseline = buildPlans({ demand: input.demand, offers: [input.offers[2]], maxStates: 1 });
  assert.deepEqual(withoutBaseline.plans, []);
  assert.equal(withoutBaseline.search.truncated, true);
});

test('retains repeated packages plus singles even when traversal is truncated early', () => {
  const input = { demand: demand({ burger: 2, fries: 2 }), maxStates: 1, limit: 3, offers: [
    offer('single-burger', 2250, { burger: 1 }), offer('single-fries', 1450, { fries: 1 }),
    offer('three-piece', 3350, { burger: 1, fries: 1, drink: 1 }),
  ] };
  const result = buildPlans(input);
  verify(input, result);
  assert.equal(result.search.truncated, true);
  assert.equal(result.plans[0].estimatedCents, 6700);
  assert.ok(result.plans.some(plan => plan.estimatedCents === 7400));
});

test('matches an independent exhaustive quantity oracle on several small catalogs', () => {
  for (let price = 0; price < 6; price++) {
    const input = { demand: demand({ A: 2, B: 2 }), limit: 12, offers: [
      offer('a', 6, { A: 1 }), offer('b', 7, { B: 1 }),
      offer('ab', price + 5, { A: 1, B: 1 }), offer('aab', 16 - price, { A: 2, B: 1 }),
    ] };
    const result = buildPlans(input);
    verify(input, result);
    assert.equal(result.search.truncated, false);
    assert.equal(result.plans[0].estimatedCents, bruteMinimum(input));
  }
});

test('validates input shapes, numeric bounds, identities, and request quantities', () => {
  const valid = () => ({ demand: demand({ A: 1 }), offers: [offer('a', 1, { A: 1 })] });
  const invalid = [
    undefined, null, [], {}, { demand: {}, offers: [] }, { demand: [], offers: {} },
    ...[0, 13, 1.5, '8', null].map(limit => ({ ...valid(), limit })),
    ...[0, 50001, NaN, Infinity, '1'].map(maxStates => ({ ...valid(), maxStates })),
    ...[0, -1, 1.5, '1', NaN, Infinity, 51].map(quantity => ({ ...valid(), demand: [{ sku: 'A', quantity }] })),
    { ...valid(), demand: demand({ A: 25, B: 26 }) },
    { ...valid(), demand: Array.from({ length: 13 }, (_, i) => ({ sku: String(i), quantity: 1 })) },
    { ...valid(), demand: [{ sku: '', quantity: 1 }] },
    { ...valid(), offers: Array.from({ length: 601 }, (_, i) => offer(String(i), 1, { A: 1 })) },
    { ...valid(), offers: [offer('a', 1, { A: 1 }), offer('a', 2, { A: 1 })] },
    ...[-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(price => ({ ...valid(), offers: [offer('a', price, { A: 1 })] })),
    ...[0, 31, 1.1, '1'].map(quantity => ({ ...valid(), offers: [offer('a', 1, { A: quantity })] })),
    { ...valid(), offers: [offer('a', 1, { A: 16, B: 15 })] },
    ...[{ id: '' }, { name: '' }, { quantity: 2 }, { components: [] }, { components: [{}] },
      { requestItem: {} }, { requestItem: { productCode: 'a', quantity: 2 } },
      { requestItem: { productCode: 'a', quantity: 1, roundList: {} } },
      { requestItem: { productCode: 'a', quantity: 1, payload: () => 1 } },
    ].map(patch => ({ ...valid(), offers: [{ ...offer('a', 1, { A: 1 }), ...patch }] })),
  ];
  const cyclic = valid();
  cyclic.offers[0].requestItem.self = cyclic.offers[0].requestItem;
  invalid.push(cyclic);
  for (const input of invalid) assert.throws(() => buildPlans(input), error => error instanceof PlanningError && error.code === 'INVALID_INPUT');
});

test('accepts documented upper bounds, empty demand, and reports aggregate price overflow', () => {
  const offers = Array.from({ length: 600 }, (_, i) => offer(String(i), 0, { A: 30 }));
  const bounded = buildPlans({ demand: demand({ A: 50 }), offers, maxStates: 1, limit: 12 });
  assert.deepEqual(bounded.plans, []);
  assert.equal(bounded.search.states, 1);
  assert.equal(bounded.search.truncated, true);
  const empty = buildPlans({ demand: [], offers: [], maxStates: 50000 });
  assert.deepEqual(empty.plans, [{ id: 'plan-1', estimatedCents: 0, usedOffers: [], items: [], components: [], extras: [] }]);
  const maxPrice = { demand: demand({ A: 1 }), offers: [offer('a', Number.MAX_SAFE_INTEGER, { A: 1 })] };
  assert.equal(buildPlans(maxPrice).plans[0].estimatedCents, Number.MAX_SAFE_INTEGER);
  assert.throws(() => buildPlans({ ...maxPrice, demand: demand({ A: 2 }) }), error => error instanceof PlanningError && error.code === 'PRICE_OVERFLOW');
});
