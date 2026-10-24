import test from "node:test";
import assert from "node:assert/strict";
import { officialImageUrl, storeMapUrl } from "../place-media.mjs";
import { loadCatalog } from "../catalog.mjs";
import { memberView, createRoom, digest } from "../room.mjs";

test("official image URLs require exact trusted HTTPS hosts without credentials or alternate ports", () => {
  // Given / When / Then
  assert.equal(officialImageUrl("https://menu-img.mcd.cn/menu/item.png#fragment"),
    "https://menu-img.mcd.cn/menu/item.png");
  for (const value of [
    "http://menu-img.mcd.cn/item.png", "https://menu-img.mcd.cn.evil.invalid/item.png",
    "https://evil.invalid/?url=https://img.mcd.cn", "https://user:secret@img.mcd.cn/item.png",
    "https://img.mcd.cn:8443/item.png", "data:image/svg+xml,anything", "javascript:alert(1)",
    "//menu-img.mcd.cn/item.png", null, {},
  ]) assert.equal(officialImageUrl(value), null);
});

test("map searches preserve official store names and addresses without inventing coordinates", () => {
  // Given
  const store = {
    city: "北京", storeName: "麦当劳测试店 & 分店", address: "某街 1 号 # 二层",
    latitude: 0, longitude: 0, token: "private-token",
  };
  // When
  const url = new URL(storeMapUrl(store));
  // Then
  assert.equal(url.origin, "https://uri.amap.com");
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("city"), "北京");
  assert.equal(url.searchParams.get("keyword"), "麦当劳测试店 & 分店 某街 1 号 # 二层");
  assert.equal(url.searchParams.get("view"), "map");
  assert.equal(url.searchParams.has("center"), false);
  assert.equal(url.href.includes("private-token"), false);
});

test("catalog preserves per-SKU official images including verified size variants", async () => {
  // Given
  const gateway = { async call(name, args) {
    if (name === "query-meals") return {
      categories: [{ name: "饮品", meals: [{ code: "drink-group" }] }],
      meals: {
        burger: { currentPrice: "20", image: "https://menu-img.mcd.cn/burger-small.png" },
        "drink-group": { currentPrice: "9", image: "https://menu-img.mcd.cn/drink-family.png" },
      },
    };
    if (args.code === "burger") return {
      code: "burger", name: "汉堡单品", rounds: [], image: "https://menu-img.mcd.cn/burger-large.png",
    };
    if (args.code === "drink-group") return {
      code: "drink-group", name: "饮料规格", image: "https://menu-img.mcd.cn/drink-family.png",
      rounds: [{
        id: 1, quantity: 1, minQuantity: 1, maxQuantity: 1,
        choices: [
          { code: "drink-small", name: "可乐小杯", maxQuantity: -1, isDefault: 1, diffPrice: "+ ¥0" },
          { code: "drink-large", name: "可乐大杯", maxQuantity: -1, isDefault: 0, diffPrice: "+ ¥2" },
        ],
      }],
    };
    return {
      code: args.code, name: args.code === "drink-small" ? "可乐小杯" : "可乐大杯", rounds: [],
      image: args.code === "drink-small" ? "https://img.mcd.cn/small-cola.png" : "https://untrusted.invalid/image.png",
    };
  } };
  // When
  const catalog = await loadCatalog(gateway, "123");
  const bySku = Object.fromEntries(catalog.singles.map((item) => [item.sku, item]));
  const room = createRoom({
    title: "图片测试", store: { storeCode: "123", storeName: "公开门店", city: "北京", address: "公开地址" },
    catalog, joinHash: digest("synthetic-invite"),
  });
  const view = memberView(room);
  // Then
  assert.equal(bySku.burger.imageUrl, "https://menu-img.mcd.cn/burger-large.png");
  assert.equal(bySku["drink-small"].imageUrl, "https://img.mcd.cn/small-cola.png");
  assert.equal(bySku["drink-large"].imageUrl, null);
  assert.equal(bySku["drink-large"].estimatedCents, 1100);
  assert.equal(view.menu.find((item) => item.sku === "drink-small").imageUrl, bySku["drink-small"].imageUrl);
  assert.equal(view.store.address, "公开地址");
});
