import { createHash, randomUUID } from "node:crypto";
import { createDesk } from "./state.mjs";

export class RoomError extends Error {
  constructor(code, message, status = 409) {
    super(message); this.name = "RoomError"; this.code = code; this.status = status;
  }
}
const named = (value) => typeof value === "string" && value.trim().length > 0 &&
  value.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const changed = (room, patch) => ({ ...room, ...patch, version: room.version + 1 });

export function expectVersion(room, version) {
  if (room.version !== version) throw new RoomError("ROOM_CHANGED", "餐桌已变化，请刷新后重新确认。");
}

export function createRoom({ title, store, catalog, joinHash }) {
  if (!named(title) || !store?.storeCode || !store.storeName || !catalog?.singles?.length ||
      !/^[a-f0-9]{64}$/.test(joinHash)) {
    throw new RoomError("INVALID_ROOM", "请先选择门店并读取真实单品菜单。", 400);
  }
  return {
    schema: 1, id: randomUUID(), title: title.trim(),
    store: {
      storeCode: store.storeCode, storeName: store.storeName, address: store.address ?? "",
      city: store.city ?? "", businessStartTime: store.businessStartTime ?? "",
      businessEndTime: store.businessEndTime ?? "",
    },
    catalog, joinHash, version: 1, phase: "collecting", members: [],
    fulfillment: store.fulfillment?.mode === "delivery"
      ? { mode: "delivery", addressId: store.fulfillment.addressId, beCode: store.fulfillment.beCode }
      : { mode: "pickup" },
    locked: null, plans: [], confirmation: null, attempt: null, order: null, desk: null,
    createdAt: new Date().toISOString(),
  };
}

export function joinRoom(room, { name, keyHash }) {
  if (room.phase !== "collecting") throw new RoomError("ROOM_LOCKED", "本桌已截止收集。");
  if (!named(name) || !/^[a-f0-9]{64}$/.test(keyHash) || room.members.length >= 50) {
    throw new RoomError("INVALID_MEMBER", "请输入1至80字的昵称；一桌最多50位成员。", 400);
  }
  if (room.members.some((member) => member.name === name.trim())) {
    throw new RoomError("NAME_TAKEN", "这个昵称已有人使用，请换一个便于区分的昵称。", 400);
  }
  const member = { id: `member-${randomUUID()}`, name: name.trim(), keyHash, revision: 0, wishes: [], submitted: false };
  return { room: changed(room, { members: [...room.members, member] }), member };
}

export function aggregateDemand(members) {
  const totals = new Map();
  for (const member of members.filter((item) => item.submitted)) {
    for (const item of member.wishes) totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.quantity);
  }
  const demand = [...totals].sort(([a], [b]) => a.localeCompare(b))
    .map(([sku, quantity]) => ({ sku, quantity }));
  if (demand.length > 12 || demand.reduce((sum, item) => sum + item.quantity, 0) > 50) {
    throw new RoomError("DEMAND_LIMIT", "本版一桌最多支持12种、合计50份单品意愿。", 400);
  }
  return demand;
}

export function submitWishes(room, { memberId, revision, items }) {
  if (room.phase !== "collecting") throw new RoomError("ROOM_LOCKED", "本桌已截止，暂时不能改单。");
  const member = room.members.find((item) => item.id === memberId);
  if (!member) throw new RoomError("MEMBER_REQUIRED", "请先加入这张餐桌。", 403);
  if (member.revision !== revision) throw new RoomError("STALE_WISHES", "你的意愿已在其他页面更新，请先刷新。");
  if (!Array.isArray(items) || items.length > 12) {
    throw new RoomError("INVALID_WISHES", "请选择单品和份数。", 400);
  }
  const ids = new Set();
  const wishes = items.map((item) => {
    if (!item || !room.catalog.singles.some((single) => single.sku === item.sku) ||
        ids.has(item.sku) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      throw new RoomError("INVALID_WISHES", "意愿只能包含当前菜单中的单品及有效数量。", 400);
    }
    ids.add(item.sku);
    return { sku: item.sku, quantity: item.quantity };
  });
  const members = room.members.map((item) => item.id === memberId
    ? { ...item, wishes, submitted: true, revision: item.revision + 1 } : item);
  aggregateDemand(members);
  return changed(room, { members });
}

export function freezeRoom(room) {
  if (room.phase !== "collecting") throw new RoomError("ROOM_LOCKED", "本桌已经截止或正在处理订单。");
  if (!room.members.length || room.members.some((member) => !member.submitted)) {
    throw new RoomError("WAITING_MEMBERS", "请等已加入的成员提交；不点餐也可以提交空清单。");
  }
  const demand = aggregateDemand(room.members);
  if (!demand.length) throw new RoomError("EMPTY_DEMAND", "大家还没有选择餐品。");
  const perMember = room.members.map(({ id, name, wishes }) => ({ id, name, wishes }));
  return changed(room, {
    phase: "planning", plans: [], confirmation: null,
    locked: { demand, perMember, digest: digest(perMember), menuSnapshotId: room.catalog.snapshotId },
  });
}

export function reopenRoom(room) {
  if (!["planned", "confirmed"].includes(room.phase)) {
    throw new RoomError("CANNOT_REOPEN", "下单已开始或状态尚未明确，不能重新收集。");
  }
  return changed(room, { phase: "collecting", locked: null, plans: [], confirmation: null });
}

export function makeDesk(room, plan) {
  const all = new Map();
  for (const item of [...plan.components, ...plan.extras]) {
    const previous = all.get(item.sku);
    all.set(item.sku, { ...item, quantity: (previous?.quantity ?? 0) + item.quantity });
  }
  const physical = [...all.values()];
  const mapping = new Map(physical.map((item, index) => [item.sku, `food-${index + 1}`]));
  return createDesk({
    title: room.title, source: "imported",
    items: physical.map((item) => ({
      id: mapping.get(item.sku), name: item.name, category: item.category, expected: item.quantity,
    })),
    people: room.locked.perMember.filter((member) => member.wishes.length).map((member) => ({
      id: member.id, name: member.name,
      wants: member.wishes.map((item) => ({ itemId: mapping.get(item.sku), quantity: item.quantity })),
    })),
  });
}

export function memberView(room, member = null) {
  return {
    id: room.id, title: room.title, phase: room.phase, version: room.version,
    storeName: room.store.storeName,
    fulfillment: room.fulfillment?.mode ?? "pickup",
    store: room.store,
    menu: room.catalog.singles.map(({ sku, name, estimatedCents, category, menuGroup, imageUrl }) =>
      ({ sku, name, estimatedCents, category, menuGroup, imageUrl: imageUrl ?? null })),
    fetchedAt: room.catalog.fetchedAt, memberCount: room.members.length,
    submittedCount: room.members.filter((item) => item.submitted).length,
    me: member ? {
      id: member.id, name: member.name, revision: member.revision,
      wishes: member.wishes, submitted: member.submitted,
    } : null,
  };
}

export function organizerView(room, paymentUrl = null) {
  return {
    id: room.id, title: room.title, version: room.version, phase: room.phase,
    store: room.store, menu: room.catalog.singles, coverage: room.catalog.coverage,
    members: room.members.map(({ id, name, revision, wishes, submitted }) => ({ id, name, revision, wishes, submitted })),
    locked: room.locked, plans: room.plans, search: room.search ?? null,
    selectedPlanId: room.confirmation?.planId ?? null, orderId: room.order?.orderId ?? null,
    fulfillment: room.fulfillment?.mode ?? "pickup",
    paymentUrl, receiptReady: room.phase === "intaken", review: room.review ?? null,
    createdAt: room.createdAt,
  };
}
