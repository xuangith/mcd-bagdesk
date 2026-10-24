function roundChoices(round, wanted) {
  const cheapest = [...round.choices].sort((a, b) => a.deltaCents - b.deltaCents).slice(0, 2);
  const choices = round.choices.filter((choice) =>
    wanted.has(choice.sku) || choice.preferred || cheapest.some((item) => item.sku === choice.sku));
  const results = [];
  let truncated = choices.length < round.choices.length;
  function expand(index, remaining, selected) {
    if (results.length >= 40) { truncated = true; return; }
    if (index === choices.length) {
      if (remaining === 0) results.push(selected);
      return;
    }
    const choice = choices[index];
    for (let quantity = Math.min(remaining, choice.maximum); quantity >= 0; quantity -= 1) {
      expand(index + 1, remaining - quantity,
        quantity ? [...selected, { ...choice, quantity }] : selected);
    }
  }
  expand(0, round.quantity, []);
  return { options: results, truncated };
}

export function offerPool(catalog, demand) {
  const wanted = new Set(demand.map((item) => item.sku));
  const singles = new Map(catalog.singles.map((item) => [item.sku, item]));
  const offers = catalog.singles.filter((item) => wanted.has(item.sku)).map((item) => ({
    id: `single-${item.sku}`, name: item.name, estimatedCents: item.estimatedCents,
    components: [{ sku: item.sku, name: item.name, category: item.category, quantity: 1 }],
    requestItem: { productCode: item.sku, quantity: 1 },
  }));
  let truncated = catalog.coverage.variantsTruncated === true;
  let bundleVariants = 0;
  for (const bundle of catalog.bundles) {
    if (!bundle.rounds.some((round) => round.choices.some((choice) => wanted.has(choice.sku)))) continue;
    let configurations = [[]];
    for (const round of bundle.rounds) {
      const result = roundChoices(round, wanted);
      truncated ||= result.truncated;
      const next = [];
      for (const previous of configurations) {
        for (const option of result.options) {
          if (next.length >= 80) { truncated = true; break; }
          next.push([...previous, { round: round.id, selected: option }]);
        }
        if (next.length >= 80) break;
      }
      configurations = next;
    }
    for (const [index, configuration] of configurations.entries()) {
      if (offers.length >= 600) { truncated = true; break; }
      const components = new Map();
      let estimatedCents = bundle.estimatedCents;
      for (const round of configuration) {
        for (const choice of round.selected) {
          estimatedCents += choice.deltaCents * choice.quantity;
          const item = components.get(choice.sku) ?? {
            sku: choice.sku, name: singles.get(choice.sku)?.name ?? choice.name,
            category: singles.get(choice.sku)?.category ?? "other", quantity: 0,
          };
          components.set(choice.sku, { ...item, quantity: item.quantity + choice.quantity });
        }
      }
      if (!Number.isSafeInteger(estimatedCents) || estimatedCents < 0 ||
          [...components.values()].reduce((sum, item) => sum + item.quantity, 0) > 30) continue;
      offers.push({
        id: `bundle-${bundle.code}-${index}`, name: bundle.name, estimatedCents,
        components: [...components.values()],
        requestItem: {
          productCode: bundle.code, quantity: 1,
          roundList: configuration.map((round) => ({
            round: round.round,
            comboItemList: round.selected.map((choice) => ({ code: choice.sku, quantity: choice.quantity })),
          })),
        },
      });
      bundleVariants += 1;
    }
    if (offers.length >= 600) break;
  }
  return { offers, coverage: { ...catalog.coverage, bundleVariants, variantsTruncated: truncated } };
}
