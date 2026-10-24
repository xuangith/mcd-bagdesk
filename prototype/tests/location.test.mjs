import test from "node:test";
import assert from "node:assert/strict";
import { createLocator, straightDistance } from "../location.mjs";

test("unconfigured location does not request or expose a key", () => {
  // Given / When / Then
  assert.equal(createLocator(), null);
});

test("GPS converts before reverse lookup and store distances use the same coordinate system", async () => {
  // Given
  const calls = [];
  const locator = createLocator({ key: "synthetic-key-not-a-real-key", request: async (value, options) => {
    const url = new URL(value);
    calls.push(url);
    assert.equal(url.origin, "https://restapi.amap.com");
    assert.equal(options.redirect, "error");
    if (url.pathname.endsWith("/convert")) return Response.json({ status: "1", locations: "116.400000,39.900000" });
    if (url.pathname.endsWith("/regeo")) return Response.json({
      status: "1", regeocode: {
        formatted_address: "北京市东城区测试地标",
        addressComponent: { city: [], province: "北京市", district: "东城区" },
      },
    });
    return Response.json({ status: "1", geocodes: [{ level: "兴趣点", location: "116.401000,39.900000" }] });
  } });
  const directory = {
    stores: new Map(),
    async search(city, keyword) {
      assert.equal(city, "北京市");
      assert.equal(keyword, "北京市东城区测试地标");
      return [{ selectionKey: "s1", storeName: "合成餐厅", address: "公开地址", businessStatus: true }];
    },
  };
  // When
  const result = await locator.nearby(directory, { consent: true, longitude: 116.39, latitude: 39.89, accuracy: 30 });
  // Then
  assert.equal(calls[0].searchParams.get("coordsys"), "gps");
  assert.equal(calls[1].searchParams.get("location"), "116.400000,39.900000");
  assert.ok(result.stores[0].distanceMeters > 80 && result.stores[0].distanceMeters < 90);
  assert.equal(result.location.accuracyMeters, 30);
  const response = JSON.stringify(result);
  assert.equal(response.includes("synthetic-key"), false);
  assert.equal(response.includes("116.39"), false);
  assert.equal(response.includes("latitude"), false);
});

test("missing consent and weak location precision fail before calling a provider", async () => {
  // Given
  let calls = 0;
  const locator = createLocator({ key: "synthetic-key-not-a-real-key", request: async () => { calls++; } });
  // When / Then
  await assert.rejects(locator.nearby({}, { consent: false, longitude: 116, latitude: 39, accuracy: 10 }),
    { code: "LOCATION_REQUIRED" });
  await assert.rejects(locator.nearby({}, { consent: true, longitude: 116, latitude: 39, accuracy: 6000 }),
    { code: "LOCATION_REQUIRED" });
  assert.equal(calls, 0);
});

test("provider failures do not echo key-bearing URLs", async () => {
  // Given
  const key = "synthetic-secret-key-for-test";
  const locator = createLocator({ key, request: async (url) => { throw new Error(url); } });
  // When / Then
  await assert.rejects(locator.nearby({}, { consent: true, longitude: 116, latitude: 39, accuracy: 10 }),
    (error) => error.code === "MAP_UNAVAILABLE" && !error.message.includes(key));
});

test("straight-line distance is symmetric and identical positions have zero distance", () => {
  // Given
  const a = { longitude: 120, latitude: 30 }, b = { longitude: 120.1, latitude: 30.1 };
  // When / Then
  assert.equal(straightDistance(a, a), 0);
  assert.equal(straightDistance(a, b), straightDistance(b, a));
});
