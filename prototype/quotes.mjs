import { RoomError } from "./room.mjs";
import { channelArgs } from "./fulfillment.mjs";

const named = (value) => typeof value === "string" && value.length > 0 && value.length <= 100;
const totals = (items, codeKey) => {
  const map = new Map();
  for (const item of items) {
    const code = item[codeKey];
    if (!named(code) || !Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new RoomError("QUOTE_FORMAT", "官方报价缺少可核对的餐品数量。", 502);
    }
    map.set(code, (map.get(code) ?? 0) + item.quantity);
  }
  return JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b)));
};

export function quoteArgs(room, items) {
  return { ...channelArgs(room.store.storeCode, room.fulfillment), items };
}

export function normalizeQuote(data, plan, room) {
  const delivery = room?.fulfillment?.mode === "delivery";
  if (!data || !Number.isSafeInteger(data.price) || data.price < 0 ||
      !Array.isArray(data.productList) || (!delivery && !Array.isArray(data.takeWayList)) ||
      totals(data.productList, "productCode") !== totals(plan.items, "productCode")) {
    throw new RoomError("QUOTE_MISMATCH", "官方返回的餐品、数量或金额与候选不一致。", 502);
  }
  const takeWays = (Array.isArray(data.takeWayList) ? data.takeWayList : []).filter((item) =>
    named(item.code) && named(item.title)).map(({ code, title }) => ({ code, title }));
  if ((!delivery && !takeWays.length) || data.productList.some((item) => !named(item.productName)) ||
      (delivery && (!Number.isSafeInteger(data.deliveryPrice) || data.deliveryPrice < 0))) {
    throw new RoomError("QUOTE_FORMAT", "官方报价缺少餐品名称或取餐方式。", 502);
  }
  const quotedAt = Date.now();
  return {
    priceCents: data.price, quotedAt, expiresAt: quotedAt + 90_000, takeWays,
    deliveryCents: delivery ? data.deliveryPrice : 0,
    packingCents: Number.isSafeInteger(data.packingPrice) && data.packingPrice >= 0 ? data.packingPrice : null,
    products: data.productList.map((item) => ({
      code: item.productCode, name: item.productName, quantity: item.quantity,
    })),
  };
}

export function supportedCart(plan) {
  const configs = new Map();
  for (const item of plan.items) {
    const signature = JSON.stringify(item.roundList ?? []);
    if (configs.has(item.productCode) && configs.get(item.productCode) !== signature) return false;
    configs.set(item.productCode, signature);
  }
  return true;
}
