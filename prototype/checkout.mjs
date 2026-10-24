import { randomBytes } from "node:crypto";
import { RoomError, digest, makeDesk } from "./room.mjs";
import { cents } from "./catalog.mjs";
import { inspectOrder } from "./order.mjs";
import { quoteArgs, normalizeQuote } from "./quotes.mjs";
import { packageContentsMatch } from "./order-match.mjs";

const key = () => randomBytes(24).toString("base64url");
const paidStates = new Set(["2", "4", "6", "8", "10"]);
const signature = (items) => {
  const totals = new Map();
  for (const item of items) {
    const name = item.name.replace(/\s/g, "");
    totals.set(name, (totals.get(name) ?? 0) + item.quantity);
  }
  return JSON.stringify([...totals].sort(([a], [b]) => a.localeCompare(b)));
};

function selected(room) {
  const plan = room.plans.find((item) => item.id === room.confirmation?.planId);
  if (!plan || room.confirmation.digest !== room.locked?.digest ||
      room.locked.menuSnapshotId !== room.catalog.snapshotId) {
    throw new RoomError("CONFIRMATION_CHANGED", "餐单依据已变化，请重新计算并确认。");
  }
  return plan;
}

export async function confirmPlan(service, room, input) {
  if (!["planned", "confirmed"].includes(room.phase)) {
    throw new RoomError("NOT_PLANNED", "请先截止收集并取得官方报价。");
  }
  const plan = room.plans.find((item) => item.id === input.planId);
  if (!plan || plan.quote.expiresAt < Date.now()) {
    throw new RoomError("QUOTE_EXPIRED", "报价已过期，请重新计算。");
  }
  const delivery = room.fulfillment?.mode === "delivery";
  if (!delivery && !plan.quote.takeWays.some((item) => item.code === input.takeWayCode)) {
    throw new RoomError("TAKE_WAY_REQUIRED", "请从官方返回的取餐方式中选择。", 400);
  }
  if (delivery && (typeof input.addressHash !== "string" || !/^[a-f0-9]{64}$/.test(input.addressHash))) {
    throw new RoomError("ADDRESS_CONFIRMATION", "请先刷新并核对收货地址。", 400);
  }
  const addressHash = delivery ? await service.directory.verifyDelivery(room, input.addressHash) : null;
  makeDesk(room, plan);
  const nonce = key();
  const next = await service.save(room, {
    phase: "confirmed",
    confirmation: {
      planId: plan.id, takeWayCode: delivery ? null : input.takeWayCode, priceCents: plan.quote.priceCents,
      addressHash,
      digest: room.locked.digest, nonceHash: digest(nonce),
    },
  });
  return { room: next, nonce };
}

export async function startOrder(service, room, input) {
  if (room.phase !== "confirmed" || input.confirmed !== true ||
      typeof input.nonce !== "string" || digest(input.nonce) !== room.confirmation?.nonceHash) {
    throw new RoomError("CONFIRMATION_REQUIRED", "请核对完整餐单、额外餐品、金额和取餐方式后明确确认。");
  }
  const plan = selected(room);
  if (plan.quote.expiresAt < Date.now()) throw new RoomError("QUOTE_EXPIRED", "报价已过期，请重新计算。");
  const delivery = room.fulfillment?.mode === "delivery";
  if (delivery) await service.directory.verifyDelivery(room, room.confirmation.addressHash);
  const latest = normalizeQuote(await service.gateway.call("calculate-price", quoteArgs(room, plan.items)), plan, room);
  if (latest.priceCents !== room.confirmation.priceCents ||
      (!delivery && !latest.takeWays.some((item) => item.code === room.confirmation.takeWayCode))) {
    await service.save(room, {
      phase: "planned", confirmation: null,
      plans: room.plans.map((item) => item.id === plan.id ? { ...item, quote: latest } : item),
    });
    throw new RoomError("PRICE_CHANGED", "最新金额或取餐方式发生变化，请重新核对，尚未创建订单。");
  }
  const creating = await service.save(room, {
    phase: "creating", attempt: { id: key(), startedAt: new Date().toISOString() },
  });
  let result;
  try {
    result = await service.gateway.call("create-order", {
      ...quoteArgs(creating, plan.items),
      ...(delivery ? { addressId: creating.fulfillment.addressId } : { takeWayCode: creating.confirmation.takeWayCode }),
    });
  } catch (error) {
    await service.save(creating, {
      phase: error.uncertain === false ? "creation-rejected" : "creation-unknown",
      review: { message: error.uncertain === false ?
        "官方未接受创建请求，请在官方渠道核对后处理。" :
        "创建结果不明确，请先到官方订单核对。系统不会重复下单。" },
    });
    throw new RoomError("CREATE_NOT_COMPLETED", "订单创建未取得明确可继续的结果，请核对官方订单。", 502);
  }
  if (!result || typeof result.orderId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(result.orderId)) {
    await service.save(creating, {
      phase: "creation-unknown", review: { message: "未取得可核验订单号，请在官方订单中核对，不能重复创建。" },
    });
    throw new RoomError("CREATE_UNKNOWN", "创建结果缺少订单号，已停止继续创建。", 502);
  }
  try { service.reserveOrder(room.id, result.orderId); }
  catch (error) {
    await service.save(creating, {
      phase: "creation-unknown",
      review: { message: "官方返回的订单号已属于另一桌，不能重复入账，请核对官方订单。" },
    });
    throw error;
  }
  let paymentUrl = null;
  try {
    const url = new URL(result.payH5Url);
    if (url.protocol === "https:" && !url.username && !url.password) paymentUrl = url.href;
  } catch { /* 没有有效支付链接时仍保留已创建的订单号，不能重新创建。 */ }
  let next;
  try {
    next = await service.save(creating, {
      phase: "awaiting-payment",
      order: { orderId: result.orderId, createdAt: new Date().toISOString() },
      review: paymentUrl ? null : { message: "支付链接不可用，请在麦当劳官方订单中继续付款。" },
    });
  } catch {
    service.rooms.set(room.id, {
      ...creating, phase: "creation-unknown",
      order: { orderId: result.orderId }, review: { message: "订单可能已创建，但本地记录写入失败。请先核对官方订单。" },
    });
    throw new RoomError("ORDER_STORAGE", "创建后保存失败，已禁止重复下单，请核对官方订单。", 500);
  }
  if (paymentUrl) service.paymentUrls.set(room.id, paymentUrl);
  return next;
}

export async function checkPayment(service, room, verifiedData) {
  if (room.phase === "intaken") return room;
  if (!room.order?.orderId) throw new RoomError("ORDER_REQUIRED", "尚未取得可核对的订单号。");
  service.reserveOrder(room.id, room.order.orderId);
  const data = verifiedData ?? await service.gateway.call("query-order", { orderId: room.order.orderId });
  if (!data || data.orderId !== room.order.orderId) {
    throw new RoomError("ORDER_MISMATCH", "官方返回的订单号不匹配，未写入开袋台。", 502);
  }
  const status = String(data.orderStatus ?? "");
  if (status === "1") return service.save(room, { phase: "awaiting-payment", review: { message: "官方状态仍为待支付。" } });
  if (status === "7") {
    service.paymentUrls.delete(room.id);
    return service.save(room, { phase: "cancelled", review: { message: "官方订单已取消，未进入开袋台。" } });
  }
  if (!paidStates.has(status)) {
    return service.save(room, { review: { message: "官方状态暂不能确认已支付，未进入开袋台。" } });
  }
  const plan = selected(room);
  if (typeof data.storeName !== "string" ||
      data.storeName.replace(/\s/g, "") !== room.store.storeName.replace(/\s/g, "")) {
    return service.save(room, {
      phase: "paid-review", review: { message: "已付款，但官方订单门店未能与本桌确认门店对齐，请人工核对。" },
    });
  }
  const inspection = inspectOrder({ orderProductList: data.orderProductList });
  const actual = inspection.lines.map((line) => ({ name: line.name, quantity: line.parentQuantity }));
  if (signature(actual) !== signature(plan.quote.products) || !packageContentsMatch(room, plan, data)) {
    return service.save(room, {
      phase: "paid-review", review: {
        message: "已确认付款，但套餐子项或数量尚未与所选配置完整对齐，请核对官方明细，未自动生成数量。",
      },
    });
  }
  const actualCents = cents(data.realTotalAmount);
  const desk = makeDesk(room, plan);
  service.paymentUrls.delete(room.id);
  return service.save(room, {
    phase: "intaken", desk, deskVersion: 1,
    review: {
      verifiedPaid: true, mode: service.gateway.mode, status, checkedAt: new Date().toISOString(),
      actualCents, priceDifference: actualCents === null ? null : actualCents - plan.quote.priceCents,
      message: service.gateway.mode === "demo"
        ? "合成演示的付款状态与餐品已核对，未发生真实付款。额外餐品保持未分配。"
        : "官方已支付状态和订单餐品已核实，开袋清单已建立。额外餐品保持未分配。",
    },
  });
}

export async function recoverOrder(service, room, input) {
  if (!["creation-unknown", "creation-rejected"].includes(room.phase) ||
      typeof input.orderId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.orderId)) {
    throw new RoomError("RECOVERY_REQUIRED", "请从麦当劳官方订单中找到本次订单号，再进行核对。");
  }
  const data = await service.gateway.call("query-order", { orderId: input.orderId });
  const plan = selected(room);
  const lines = inspectOrder({ orderProductList: data.orderProductList }).lines
    .map((line) => ({ name: line.name, quantity: line.parentQuantity }));
  const timeText = typeof data.createTime === "string" ? data.createTime.replace(" ", "T") : "";
  const createdAt = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(timeText) ? timeText : `${timeText}+08:00`);
  if (data.orderId !== input.orderId || data.storeName !== room.store.storeName ||
      signature(lines) !== signature(plan.quote.products) ||
      !Number.isFinite(createdAt) || createdAt < Date.parse(room.attempt.startedAt) - 120000 ||
      createdAt > Date.now() + 120000) {
    throw new RoomError("ORDER_MISMATCH", "订单号、餐品或创建时间与本次请求不符，未关联。");
  }
  service.reserveOrder(room.id, input.orderId);
  const recovered = await service.save(room, {
    phase: "awaiting-payment", order: { orderId: input.orderId, createdAt: data.createTime },
  });
  return checkPayment(service, recovered, data);
}
