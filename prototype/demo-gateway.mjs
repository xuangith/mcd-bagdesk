import { randomUUID } from "node:crypto";
import { GatewayError } from "./mcp-gateway.mjs";

const singles = [
  ["1440", "麦辣鸡腿汉堡", 2250],
  ["4810", "中份薯条", 1450],
  ["3050", "可乐中杯", 1000],
  ["3505", "锡兰红茶", 1050],
];
const choices = (items) => items.map(([code, name], index) => ({
  code, name, quantity: index ? 0 : 1, maxQuantity: -1,
  isDefault: index ? 0 : 1, diffPrice: "+ ¥0",
}));
const round = (id, quantity, entries) => ({
  id, name: `合成选配组${id}`, quantity, minQuantity: quantity, maxQuantity: quantity,
  choices: choices(entries).map((choice) => ({ ...choice, quantity: choice.isDefault ? quantity : 0 })),
});
const bundles = [
  { code: "9900005456", name: "三件套（合成）", price: 3350, rounds: [
    round(1, 1, [singles[0]]), round(2, 1, [singles[1]]), round(3, 1, [singles[2], singles[3]]),
  ] },
  { code: "9900006000", name: "双人分享餐（合成）", price: 3800, rounds: [
    round(1, 2, [singles[0]]), round(2, 2, [singles[2], singles[3]]),
  ] },
];

export class DemoGateway {
  constructor() { this.mode = "demo"; this.orders = new Map(); this.createCalls = 0; }
  markDemoPaid(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError("DEMO_ORDER", "没有这个合成订单。");
    order.orderStatus = "2";
  }
  async call(name, args) {
    if (name === "delivery-query-addresses") return { addresses: [{
      addressId: "demo-address", fullAddress: "合成演示路1号 · 不是真实地址",
      contactName: "演示收件人", phone: "13800000000",
    }] };
    if (name === "delivery-query-stores") {
      if (args.addressId !== "demo-address") throw new GatewayError("ADDRESS", "合成地址无效。");
      return [{
        storeCode: "900001", storeName: "开袋台演示餐厅（合成）", beCode: "demo-delivery-code",
        businessStatus: true,
      }];
    }
    if (name === "query-nearby-stores") return [{
      storeCode: "900001", storeName: "开袋台演示餐厅（合成）", address: "合成演示地点",
      businessStatus: true,
    }];
    if (name === "query-meals") return {
      categories: [{ name: "单品", meals: singles.map(([code]) => ({ code })) }],
      meals: Object.fromEntries([
        ...singles.map(([code, label, price]) => [code, { name: label, currentPrice: String(price / 100) }]),
        ...bundles.map((item) => [item.code, { name: item.name, currentPrice: String(item.price / 100) }]),
      ]),
    };
    if (name === "query-meal-detail") {
      const single = singles.find(([code]) => code === args.code);
      if (single) return { code: single[0], name: single[1], rounds: [] };
      const bundle = bundles.find((item) => item.code === args.code);
      if (bundle) return structuredClone({ code: bundle.code, name: bundle.name, rounds: bundle.rounds });
      throw new GatewayError("60006", "合成餐品不存在。");
    }
    if (name === "calculate-price" || name === "create-order") {
      if (args.orderType === 2 && (args.beType !== 2 || args.beCode !== "demo-delivery-code")) {
        throw new GatewayError("CHANNEL", "配送渠道参数不完整。");
      }
      if (name === "create-order" && args.orderType === 2 &&
          (args.addressId !== "demo-address" || args.takeWayCode !== undefined)) {
        throw new GatewayError("CHANNEL", "配送下单地址或取餐参数错误。");
      }
      const products = args.items.map((item) => {
        const single = singles.find(([code]) => code === item.productCode);
        const bundle = bundles.find((entry) => entry.code === item.productCode);
        if (!single && !bundle) throw new GatewayError("60006", "合成餐品不存在。");
        if (bundle) {
          for (const group of bundle.rounds) {
            const selected = item.roundList?.find((entry) => entry.round === String(group.id));
            if (!selected || selected.comboItemList.reduce((n, choice) => n + choice.quantity, 0) !== group.quantity ||
                selected.comboItemList.some((choice) => !group.choices.some((valid) => valid.code === choice.code))) {
              throw new GatewayError("60006", "合成套餐选配未明确。");
            }
          }
        }
        return {
          productCode: item.productCode, productName: single?.[1] ?? bundle.name,
          quantity: item.quantity, subtotal: (single?.[2] ?? bundle.price) * item.quantity,
        };
      });
      const deliveryPrice = args.orderType === 2 ? 900 : 0;
      const price = products.reduce((sum, item) => sum + item.subtotal, 0) + deliveryPrice;
      if (name === "calculate-price") return {
        price, deliveryPrice, packingPrice: 0, productList: products,
        takeWayList: args.orderType === 2 ? [] : [{ code: "take-in-store", title: "外带（演示）" }],
      };
      this.createCalls += 1;
      const orderId = `demo-${randomUUID()}`;
      const order = {
        orderId, orderStatus: "1", createTime: new Date().toISOString(),
        storeName: "开袋台演示餐厅（合成）",
        realTotalAmount: (price / 100).toFixed(2),
        orderProductList: products.map((item, index) => ({
          productName: item.productName, quantity: item.quantity,
          comboItemList: (args.items[index].roundList ?? []).flatMap((group) =>
            group.comboItemList.map((choice) => ({
              itemName: singles.find(([sku]) => sku === choice.code)?.[1] ?? "未知合成餐品",
              itemQuantity: choice.quantity,
            }))),
        })),
      };
      this.orders.set(orderId, order);
      return { orderId, payH5Url: "https://example.invalid/simulated-payment", orderDetail: structuredClone(order) };
    }
    if (name === "query-order") {
      const order = this.orders.get(args.orderId);
      if (!order) throw new GatewayError("DEMO_ORDER", "没有这个合成订单。");
      return structuredClone(order);
    }
    throw new GatewayError("DEMO_TOOL", "演示模式不支持这个工具。");
  }
}
