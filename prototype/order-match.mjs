const key = (value) => typeof value === "string" ? value.replace(/\s/g, "") : "";
const counts = (items) => {
  const totals = new Map();
  for (const item of items) totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.quantity);
  return JSON.stringify([...totals].sort(([a], [b]) => a.localeCompare(b)));
};

export function packageContentsMatch(room, plan, data) {
  const requestedCodes = plan.items.map((item) => item.productCode);
  if (new Set(requestedCodes).size !== requestedCodes.length) return false;
  for (const request of plan.items.filter((item) => item.roundList?.length)) {
    const quoted = plan.quote.products.find((item) => item.code === request.productCode);
    const orderLines = data.orderProductList.filter((item) =>
      key(item.productName) === key(quoted?.name));
    if (orderLines.length !== 1) return false;
    const orderLine = orderLines[0];
    if (!Array.isArray(orderLine.comboItemList) || !orderLine.comboItemList.length) return false;
    const bundle = room.catalog.bundles.find((item) => item.code === request.productCode);
    if (!bundle) return false;
    const aliases = new Map();
    const wanted = [];
    for (const selected of request.roundList) {
      const round = bundle.rounds.find((item) => item.id === selected.round);
      if (!round) return false;
      for (const item of selected.comboItemList) {
        const choice = round.choices.find((candidate) => candidate.sku === item.code);
        if (!choice) return false;
        wanted.push({ sku: item.code, quantity: item.quantity * request.quantity });
        const names = [choice.name, room.catalog.singles.find((single) => single.sku === item.code)?.name]
          .filter(Boolean).map(key);
        for (const name of names) {
          const codes = aliases.get(name) ?? new Set();
          codes.add(item.code);
          aliases.set(name, codes);
        }
      }
    }
    const observed = [];
    for (const child of orderLine.comboItemList) {
      const codes = aliases.get(key(child.itemName));
      if (!codes || codes.size !== 1 || !Number.isInteger(child.itemQuantity) || child.itemQuantity < 1) return false;
      observed.push({ sku: [...codes][0], quantity: child.itemQuantity });
    }
    // The selected cart supplies the exact expected total. Both documented-in-
    // practice interpretations must reconcile to that total, or intake is held.
    const expected = counts(wanted);
    if (counts(observed) !== expected &&
        counts(observed.map((item) => ({ ...item, quantity: item.quantity * request.quantity }))) !== expected) {
      return false;
    }
  }
  return true;
}
