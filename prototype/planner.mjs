export class PlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
  }
}

const fail = (message, code = 'INVALID_INPUT') => { throw new PlanningError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function cloneJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !object(value)) || ancestors.has(value)) fail('订单参数必须是无循环的 JSON 数据');
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? Array.from(value, item => cloneJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, ancestors)]));
  ancestors.delete(value);
  return copy;
}

function normalize(input) {
  if (!object(input)) fail('规划输入必须是对象');
  const { demand, offers, limit = 8, maxStates = 20000 } = input;
  if (!Array.isArray(demand) || !Array.isArray(offers)) fail('需求和候选必须是数组');
  if (!integer(limit, 1, 12) || !integer(maxStates, 1, 50000)) fail('候选上限或状态预算超出范围');
  if (offers.length > 600) fail('候选最多允许六百种');
  const needed = new Map();
  let demandCount = 0;
  for (const row of demand) {
    if (!object(row) || !text(row.sku) || !integer(row.quantity, 1, 50)) fail('需求餐品编码或数量无效');
    demandCount += row.quantity;
    needed.set(row.sku, (needed.get(row.sku) ?? 0) + row.quantity);
    if (demandCount > 50 || needed.size > 12) fail('需求最多十二种、共五十件');
  }
  const ids = new Set();
  const normalized = offers.map(offer => {
    if (!object(offer) || !text(offer.id) || !text(offer.name) || ids.has(offer.id)) fail('候选标识或名称无效，标识不得重复');
    ids.add(offer.id);
    if (!integer(offer.estimatedCents, 0, Number.MAX_SAFE_INTEGER)) fail('估价必须是非负安全整数分');
    if (offer.quantity !== undefined && offer.quantity !== 1) fail('输入候选必须是一份');
    if (!Array.isArray(offer.components) || !offer.components.length) fail('候选必须包含餐品组成');
    let count = 0;
    const contents = new Map();
    for (const row of offer.components) {
      if (!object(row) || !text(row.sku) || !text(row.name) || !text(row.category)
          || !integer(row.quantity, 1, 30)) fail('候选餐品组成无效');
      count += row.quantity;
      if (count > 30) fail('每份候选最多三十件');
      const previous = contents.get(row.sku);
      contents.set(row.sku, {
        sku: row.sku, name: previous?.name ?? row.name, category: previous?.category ?? row.category,
        quantity: (previous?.quantity ?? 0) + row.quantity,
      });
    }
    if (!object(offer.requestItem) || !text(offer.requestItem.productCode)
        || offer.requestItem.quantity !== 1) fail('订单餐品必须有真实产品编码且数量为一');
    if (offer.requestItem.roundList !== undefined && !Array.isArray(offer.requestItem.roundList)) fail('套餐配置必须是数组');
    return {
      id: offer.id, price: BigInt(offer.estimatedCents), count, contents,
      requestItem: cloneJson(offer.requestItem),
    };
  }).sort((a, b) => compareText(a.id, b.id));
  return { needed: new Map([...needed].sort(([a], [b]) => compareText(a, b))), offers: normalized, limit, maxStates };
}

const signature = (offers, counts) => JSON.stringify(offers.flatMap((offer, i) => counts[i] ? [[offer.id, counts[i]]] : []));
const comparePlans = (a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)
  || a.extraCount - b.extraCount || compareText(a.signature, b.signature);

function assemble(offers, counts, needed) {
  const usedOffers = [], items = [], totals = new Map();
  let price = 0n;
  for (let i = 0; i < offers.length; i++) {
    if (!counts[i]) continue;
    const offer = offers[i], quantity = counts[i];
    usedOffers.push({ offerId: offer.id, quantity });
    items.push({ ...cloneJson(offer.requestItem), quantity });
    price += offer.price * BigInt(quantity);
    for (const row of offer.contents.values()) {
      const previous = totals.get(row.sku);
      totals.set(row.sku, { ...row, name: previous?.name ?? row.name, category: previous?.category ?? row.category,
        quantity: (previous?.quantity ?? 0) + row.quantity * quantity });
    }
  }
  for (const [sku, quantity] of needed) {
    if ((totals.get(sku)?.quantity ?? 0) < quantity) fail('候选未完整覆盖需求', 'INVALID_PLAN');
  }
  const components = [], extras = [];
  for (const row of [...totals.values()].sort((a, b) => compareText(a.sku, b.sku))) {
    const wanted = needed.get(row.sku) ?? 0;
    if (wanted) components.push({ ...row, quantity: wanted });
    if (row.quantity > wanted) extras.push({ ...row, quantity: row.quantity - wanted });
  }
  return { price, signature: signature(offers, counts), extraCount: extras.reduce((sum, row) => sum + row.quantity, 0),
    usedOffers, items, components, extras };
}

export function buildPlans(input) {
  const { needed, offers, limit, maxStates } = normalize(input);
  const skus = [...needed.keys()], initial = [...needed.values()];
  const covering = skus.map(sku => offers.map((offer, i) => ({ offer, i }))
    .filter(({ offer }) => offer.contents.has(sku))
    .sort((a, b) => a.offer.price < b.offer.price ? -1 : a.offer.price > b.offer.price ? 1 : compareText(a.offer.id, b.offer.id))
    .map(({ i }) => i));
  const baselineCounts = Array(offers.length).fill(0);
  let hasBaseline = true;
  for (let s = 0; s < skus.length; s++) {
    const direct = covering[s].find(i => offers[i].count === 1);
    if (direct === undefined) { hasBaseline = false; break; }
    baselineCounts[direct] = initial[s];
  }
  const baseline = hasBaseline ? assemble(offers, baselineCounts, needed) : null;
  const best = [], diverse = new Map();
  function retain(plan) {
    const family = [...new Set(plan.items.map(item => item.productCode))].sort(compareText).join("|");
    const previous = diverse.get(family);
    if (!previous || comparePlans(plan, previous) < 0) diverse.set(family, plan);
    if (diverse.size > limit * 12) {
      const last = [...diverse].sort((a, b) => comparePlans(a[1], b[1])).at(-1);
      diverse.delete(last[0]);
    }
    if (best.some(other => other.signature === plan.signature)) return;
    best.push(plan);
    best.sort(comparePlans);
    if (best.length > limit) best.pop();
  }
  if (baseline) retain(baseline);
  // Seed each package plus necessary singles before the search budget is spent.
  // This keeps an obvious repeated-package option from disappearing behind DFS order.
  if (baseline) {
    for (let i = 0; i < offers.length; i++) {
      if (offers[i].count <= 1) continue;
      const useful = Math.max(0, ...skus.map((sku, s) => {
        const covered = offers[i].contents.get(sku)?.quantity ?? 0;
        return covered ? Math.ceil(initial[s] / covered) : 0;
      }));
      for (let quantity = 1; quantity <= useful; quantity++) {
        const candidate = Array(offers.length).fill(0);
        candidate[i] = quantity;
        for (let s = 0; s < skus.length; s++) {
          const remaining = Math.max(0, initial[s] -
            (offers[i].contents.get(skus[s])?.quantity ?? 0) * quantity);
          if (remaining) {
            const direct = covering[s].find(index => offers[index].count === 1);
            candidate[direct] += remaining;
          }
        }
        retain(assemble(offers, candidate, needed));
      }
    }
  }
  const seen = new Set(), counts = Array(offers.length).fill(0);
  let states = 0, truncated = false;
  function visit(remaining) {
    const key = signature(offers, counts);
    if (seen.has(key)) return true;
    if (states === maxStates) { truncated = true; return false; }
    seen.add(key);
    states++;
    const pivot = remaining.findIndex(quantity => quantity > 0);
    if (pivot === -1) {
      retain(assemble(offers, counts, needed));
      return true;
    }
    for (const i of covering[pivot]) {
      const next = remaining.map((quantity, s) => Math.max(0, quantity - (offers[i].contents.get(skus[s])?.quantity ?? 0)));
      counts[i]++;
      const completed = visit(next);
      counts[i]--;
      if (!completed) return false;
    }
    return true;
  }
  visit(initial);
  if (states === maxStates) truncated = true;
  // Preserve different product/package families for official repricing:
  // member-card menu estimates can reverse the apparent price ordering.
  const diversified = [...diverse.values()].sort(comparePlans);
  for (const plan of best) {
    if (!diversified.some(item => item.signature === plan.signature)) diversified.push(plan);
  }
  best.splice(0, best.length, ...diversified.slice(0, limit));
  if (baseline && !best.some(plan => plan.signature === baseline.signature)) {
    if (best.length === limit) best.pop();
    best.push(baseline);
  }
  best.sort(comparePlans);
  const plans = best.map((plan, i) => {
    if (plan.price > BigInt(Number.MAX_SAFE_INTEGER)) fail('组合总价超出安全整数分范围', 'PRICE_OVERFLOW');
    return { id: `plan-${i + 1}`, estimatedCents: Number(plan.price), usedOffers: plan.usedOffers,
      items: plan.items, components: plan.components, extras: plan.extras };
  });
  return { plans, search: { states, truncated, priceBasis: 'catalog-estimate' } };
}
