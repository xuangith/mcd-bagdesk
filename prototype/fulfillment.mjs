import { RoomError, digest } from "./room.mjs";

export function channelArgs(storeCode, fulfillment = { mode: "pickup" }) {
  if (fulfillment.mode === "pickup") return { storeCode, orderType: 1, beType: 1 };
  if (fulfillment.mode !== "delivery" || typeof fulfillment.beCode !== "string" ||
      !fulfillment.beCode || typeof fulfillment.addressId !== "string" || !fulfillment.addressId) {
    throw new RoomError("DELIVERY_CONTEXT", "请选择有效的配送地址和可配送门店。", 400);
  }
  return { storeCode, orderType: 2, beType: 2, beCode: fulfillment.beCode };
}

export function addressFingerprint(address) {
  return digest([address.addressId, address.contactName, address.fullAddress, address.phone]);
}

export function addressView(address) {
  return {
    addressId: address.addressId, fullAddress: address.fullAddress, contactName: address.contactName,
    phone: address.phone.length >= 7
      ? `${address.phone.slice(0, 3)}****${address.phone.slice(-4)}` : "号码未完整返回",
  };
}
