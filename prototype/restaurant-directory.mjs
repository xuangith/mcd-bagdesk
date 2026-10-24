import { randomUUID } from "node:crypto";
import { RoomError } from "./room.mjs";
import { addressFingerprint, addressView } from "./fulfillment.mjs";

export class RestaurantDirectory {
  constructor(gateway) { this.gateway = gateway; this.stores = new Map(); this.addresses = new Map(); }
  normalize(raw, context) {
    if (!Array.isArray(raw)) throw new RoomError("STORE_FORMAT", "官方门店列表无法识别。", 502);
    const stores = raw.filter((item) => typeof item.storeCode === "string" &&
      /^\d{1,32}$/.test(item.storeCode) && typeof item.storeName === "string" &&
      item.storeName.length <= 100).flatMap((item) => {
      if (context.mode === "delivery" && (typeof item.beCode !== "string" || !item.beCode)) return [];
      const store = {
        storeCode: item.storeCode, storeName: item.storeName,
        selectionKey: context.mode === "delivery" ? `delivery-${randomUUID()}` : item.storeCode,
        address: typeof item.address === "string" ? item.address.slice(0, 300) : "",
        city: context.city ?? "",
        businessStartTime: typeof item.businessStartTime === "string" ? item.businessStartTime.slice(0, 32) : "",
        businessEndTime: typeof item.businessEndTime === "string" ? item.businessEndTime.slice(0, 32) : "",
        businessStatus: item.businessStatus === true,
        distance: Number.isFinite(item.distance) && item.distance > 0 ? item.distance : null,
        distanceBasis: context.mode === "favorites" ? "favorites" : context.mode === "delivery" ? "delivery-address" : "search-point",
        fulfillment: context.mode === "delivery"
          ? { mode: "delivery", addressId: context.addressId, beCode: item.beCode } : { mode: "pickup" },
      };
      this.stores.set(store.selectionKey, store);
      return [store];
    });
    // Only rank comparable distances from the same upstream query; no inferred origin or unit.
    return stores.sort((a, b) => Number(b.businessStatus) - Number(a.businessStatus) ||
      (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }
  search(city, keyword) {
    if (typeof city !== "string" || !city.trim() || city.length > 80 ||
        typeof keyword !== "string" || !keyword.trim() || keyword.length > 80) {
      throw new RoomError("LOCATION_REQUIRED", "请选择地点，或输入城市和附近地标。", 400);
    }
    return this.gateway.call("query-nearby-stores", {
      city: city.trim(), keyword: keyword.trim(), beType: 1, searchType: 2,
    }).then((raw) => this.normalize(raw, { mode: "pickup", city: city.trim() }));
  }
  async favorites() {
    return this.normalize(await this.gateway.call("query-nearby-stores", { beType: 1, searchType: 1 }),
      { mode: "favorites" });
  }
  async loadAddresses() {
    const raw = await this.gateway.call("delivery-query-addresses", {});
    if (!Array.isArray(raw?.addresses)) throw new RoomError("ADDRESS_FORMAT", "配送地址列表无法识别。", 502);
    this.addresses.clear();
    for (const item of raw.addresses) {
      if (typeof item.addressId !== "string" || !item.addressId || item.addressId.length > 100 ||
          typeof item.fullAddress !== "string" || !item.fullAddress || item.fullAddress.length > 500 ||
          typeof item.contactName !== "string" || item.contactName.length > 80 ||
          typeof item.phone !== "string" || !/^\d{7,15}$/.test(item.phone)) continue;
      this.addresses.set(item.addressId, {
        addressId: item.addressId, fullAddress: item.fullAddress, contactName: item.contactName, phone: item.phone,
      });
    }
    return [...this.addresses.values()].map(addressView);
  }
  async delivery(addressId) {
    if (!this.addresses.has(addressId)) throw new RoomError("ADDRESS_REQUIRED", "请先选择账户中的配送地址。", 400);
    return this.normalize(await this.gateway.call("delivery-query-stores", { addressId, beType: 2 }),
      { mode: "delivery", addressId });
  }
  async verifyDelivery(room, expectedHash) {
    const fulfillment = room.fulfillment;
    if (fulfillment?.mode !== "delivery") return null;
    await this.loadAddresses();
    const address = this.addresses.get(fulfillment.addressId);
    if (!address) throw new RoomError("ADDRESS_CHANGED", "配送地址已失效，请重新选址建桌。");
    const hash = addressFingerprint(address);
    if (expectedHash && hash !== expectedHash) {
      throw new RoomError("ADDRESS_CHANGED", "配送地址信息已变化，请刷新并重新确认，尚未下单。");
    }
    const raw = await this.gateway.call("delivery-query-stores", { addressId: fulfillment.addressId, beType: 2 });
    if (!Array.isArray(raw) || !raw.some((store) => store.storeCode === room.store.storeCode &&
        store.beCode === fulfillment.beCode && store.businessStatus === true)) {
      throw new RoomError("DELIVERY_UNAVAILABLE", "这家门店当前无法向所选地址配送，尚未下单。");
    }
    return hash;
  }
}
