import { createHash } from "node:crypto";
import { officialImageUrl } from "./place-media.mjs";
import { channelArgs } from "./fulfillment.mjs";

export class CatalogError extends Error {
  constructor(code, message) { super(message); this.name = "CatalogError"; this.code = code; }
}
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const validSku = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const validName = (value) => typeof value === "string" && value.trim().length > 0 &&
  value.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);

export function menuGroup(name, categoryNames) {
  if (categoryNames.some((value) => /饮品|麦咖啡|现磨/.test(value))) return "drink";
  if (categoryNames.some((value) => /鸡肉汉堡|牛鱼肉堡|厚牛堡|麦满分|早安营养卷|炒双蛋堡|厚松饼堡/.test(value))) return "burger";
  if (categoryNames.some((value) => /炸鸡|蘸酱/.test(value))) return "snack";
  if (/麦旋风|冰淇淋|圣代|圆筒|苹果派|菠萝派|香芋派/.test(name)) return "dessert";
  if (/堡|麦满分|卷/.test(name)) return "burger";
  if (/咖啡|奶铁|美式|可乐|雪碧|红茶|绿茶|奶茶|牛奶|果汁|纯悦|麦炫酷/.test(name)) return "drink";
  if (/薯|鸡翅|麦乐鸡|脆汁鸡|玉米杯|苹果片|小食/.test(name)) return "snack";
  return "other";
}

export function cents(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function difference(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^\s*([+-])\s*[¥￥]\s*(\d+(?:\.\d{1,2})?)\s*$/);
  if (!match) return null;
  const amount = cents(match[2]);
  return amount === null ? null : (match[1] === "-" ? -amount : amount);
}

function normalize(code, meal, detail) {
  const price = cents(meal.currentPrice);
  if (!validSku(code) || !record(detail) || detail.code !== code ||
      !validName(detail.name) || price === null || !Array.isArray(detail.rounds)) {
    throw new CatalogError("MENU_FORMAT", "餐品详情或展示价格式未获支持。");
  }
  const base = {
    code, name: detail.name.trim(), estimatedCents: price,
    imageUrl: officialImageUrl(detail.image) ?? officialImageUrl(meal.image),
  };
  if (!detail.rounds.length) return { ...base, rounds: [] };
  const ids = new Set();
  const rounds = detail.rounds.map((round) => {
    const id = String(round.id);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || ids.has(id) ||
        !Number.isInteger(round.quantity) || round.quantity < 1 || round.quantity > 4 ||
        round.minQuantity !== round.quantity || round.maxQuantity !== round.quantity ||
        !Array.isArray(round.choices) || round.choices.length > 100) {
      throw new CatalogError("OPTION_SCOPE", "暂不支持该套餐的可变数量选配组。");
    }
    ids.add(id);
    const choices = round.choices.flatMap((choice) => {
      const delta = difference(choice.diffPrice);
      if (!validSku(choice.code) || !validName(choice.name) || delta === null ||
          !Number.isInteger(choice.maxQuantity) || choice.maxQuantity === 0) return [];
      return [{
        sku: choice.code, name: choice.name.trim(), deltaCents: delta,
        maximum: choice.maxQuantity === -1 ? round.quantity :
          Math.min(round.quantity, choice.maxQuantity),
        preferred: choice.isDefault === 1,
      }];
    });
    if (!choices.length || new Set(choices.map((choice) => choice.sku)).size !== choices.length) {
      throw new CatalogError("OPTION_SCOPE", "套餐子项缺少明确编码或差价。");
    }
    return { id, quantity: round.quantity, choices };
  });
  return { ...base, rounds };
}

export async function loadCatalog(gateway, storeCode, fulfillment = { mode: "pickup" }) {
  const context = channelArgs(storeCode, fulfillment);
  const raw = await gateway.call("query-meals", context);
  if (!record(raw) || !record(raw.meals) || !Array.isArray(raw.categories)) {
    throw new CatalogError("MENU_FORMAT", "官方菜单格式无法识别。");
  }
  const entries = Object.entries(raw.meals);
  if (!entries.length || entries.length > 200) {
    throw new CatalogError("MENU_SIZE", "本版支持1至200项门店菜单。");
  }
  const results = new Array(entries.length);
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < entries.length) {
      const current = index++;
      const [code, meal] = entries[current];
      try {
        const detail = await gateway.call("query-meal-detail", { ...context, code });
        results[current] = { product: normalize(code, meal, detail) };
      } catch (error) {
        if (error.uncertain || error.code === "HTTP_401" || error.code === "HTTP_403") {
          index = entries.length;
          throw error;
        }
        results[current] = { unsupported: code };
      }
    }
  }));
  const products = results.flatMap((result) => result.product ? [result.product] : []);
  const singles = products.filter((product) => !product.rounds.length).map((product) => {
    const categoryNames = raw.categories.filter((group) =>
      group.meals?.some((item) => item.code === product.code)).map((group) => group.name);
    const group = menuGroup(product.name, categoryNames);
    return {
      sku: product.code, name: product.name, estimatedCents: product.estimatedCents, imageUrl: product.imageUrl,
      menuGroup: group,
      category: group === "burger" ? "burger" : group === "drink" ? "drink" :
        /薯条/.test(product.name) ? "fries" : "other",
    };
  });
  // A one-item menu group can be a size selector rather than a meal package.
  // Verify each child as an actual single product before exposing it to members.
  const variantCandidates = new Map();
  for (const product of products.filter((item) => item.rounds.length === 1 && item.rounds[0].quantity === 1)) {
    for (const choice of product.rounds[0].choices) {
      const estimate = product.estimatedCents + choice.deltaCents;
      if (singles.some((item) => item.sku === choice.sku) || estimate < 0) continue;
      const previous = variantCandidates.get(choice.sku);
      if (!previous || estimate < previous.estimatedCents) variantCandidates.set(choice.sku, {
        sku: choice.sku, estimatedCents: estimate,
      });
    }
  }
  const variants = [...variantCandidates.values()].slice(0, 100);
  let variantIndex = 0;
  const variantResults = new Array(variants.length);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (variantIndex < variants.length) {
      const current = variantIndex++;
      const variant = variants[current];
      try {
        const detail = await gateway.call("query-meal-detail", {
          ...context, code: variant.sku,
        });
        if (detail.code === variant.sku && validName(detail.name) &&
            Array.isArray(detail.rounds) && detail.rounds.length === 0) {
          const group = menuGroup(detail.name, []);
          variantResults[current] = {
            ...variant, name: detail.name.trim(), menuGroup: group, imageUrl: officialImageUrl(detail.image),
            category: group === "burger" ? "burger" : group === "drink" ? "drink" :
              /薯条/.test(detail.name) ? "fries" : "other",
          };
        }
      } catch (error) {
        if (error.uncertain || error.code === "HTTP_401" || error.code === "HTTP_403") {
          variantIndex = variants.length;
          throw error;
        }
      }
    }
  }));
  singles.push(...variantResults.filter(Boolean));
  if (!singles.length) throw new CatalogError("NO_SINGLES", "没有读取到可确认的默认规格单品。");
  const fetchedAt = new Date().toISOString();
  return {
    snapshotId: createHash("sha256").update(JSON.stringify({ storeCode, fetchedAt, products })).digest("hex"),
    fetchedAt, singles, bundles: products.filter((product) => product.rounds.length > 0),
    coverage: {
      menuProducts: entries.length, detailsFetched: products.length,
      unsupportedProducts: results.flatMap((result) => result.unsupported ? [result.unsupported] : []),
      variantCandidates: variantCandidates.size, verifiedVariants: variantResults.filter(Boolean).length,
      variantsTruncated: variantCandidates.size > variants.length,
    },
  };
}
