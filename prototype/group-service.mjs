import { randomBytes } from "node:crypto";
import {
  RoomError, changed, createRoom, digest, expectVersion, freezeRoom, joinRoom,
  makeDesk, reopenRoom, submitWishes,
} from "./room.mjs";
import { loadCatalog } from "./catalog.mjs";
import { offerPool } from "./offers.mjs";
import { buildPlans } from "./planner.mjs";
import { normalizeQuote, quoteArgs, supportedCart } from "./quotes.mjs";
import { checkPayment, confirmPlan, recoverOrder, startOrder } from "./checkout.mjs";
import { reduceDesk } from "./state.mjs";
import { RestaurantDirectory } from "./restaurant-directory.mjs";

const secret = () => randomBytes(24).toString("base64url");

export class GroupService {
  constructor(gateway, store) {
    this.gateway = gateway; this.store = store;
    this.rooms = new Map(); this.directory = new RestaurantDirectory(gateway);
    this.stores = this.directory.stores; this.catalogs = new Map();
    this.paymentUrls = new Map(); this.busy = new Set(); this.orderOwners = new Map();
  }
  async initialize() {
    await this.store.initialize();
    for (const room of await this.store.readAll()) {
      if (room.order?.orderId) this.reserveOrder(room.id, room.order.orderId);
      let next = room;
      if (room.phase === "creating") next = changed(room, {
        phase: "creation-unknown", review: { message: "上次创建过程中服务中断，请先核对官方订单，不能重复创建。" },
      });
      if (room.phase === "planning") next = changed(room, {
        phase: "planned", plans: [], confirmation: null,
        review: { message: "上次核价中断，可重新计算，不会自动下单。" },
      });
      if (next !== room) await this.store.write(next);
      this.rooms.set(next.id, next);
    }
  }
  room(id) {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "没有找到这张餐桌。", 404);
    return room;
  }
  reserveOrder(id, orderId) {
    const owner = this.orderOwners.get(orderId);
    if (owner && owner !== id) {
      throw new RoomError("ORDER_ALREADY_LINKED", "这个官方订单已属于另一张餐桌，不能再次入账。");
    }
    this.orderOwners.set(orderId, id);
  }
  async save(room, patch) {
    const next = changed(room, patch);
    await this.store.write(next);
    this.rooms.set(next.id, next);
    return next;
  }
  async mutate(id, version, action) {
    if (this.busy.has(id)) throw new RoomError("ROOM_BUSY", "本桌正在核价或处理订单，请稍后刷新。");
    this.busy.add(id);
    try {
      const room = this.room(id);
      if (version !== undefined) expectVersion(room, version);
      return await action(room);
    } finally { this.busy.delete(id); }
  }
  async searchStores(city, keyword) {
    return this.directory.search(city, keyword);
  }
  async create(input) {
    const store = this.stores.get(input.storeCode);
    if (!store?.businessStatus) throw new RoomError("STORE_REQUIRED", "请从查询结果选择营业中的门店。", 400);
    const cacheKey = JSON.stringify([store.storeCode, store.fulfillment]);
    let cached = this.catalogs.get(cacheKey);
    if (!cached || Date.now() - cached.at > 300_000) {
      cached = { at: Date.now(), promise: loadCatalog(this.gateway, store.storeCode, store.fulfillment) };
      this.catalogs.set(cacheKey, cached);
    }
    let catalog;
    try { catalog = await cached.promise; }
    catch (error) { this.catalogs.delete(cacheKey); throw error; }
    const joinKey = secret();
    const room = createRoom({ title: input.title, store, catalog, joinHash: digest(joinKey) });
    await this.store.write(room);
    this.rooms.set(room.id, room);
    return { room, joinKey };
  }
  async join(id, input) {
    return this.mutate(id, undefined, async (room) => {
      const memberKey = secret();
      const result = joinRoom(room, { name: input.name, keyHash: digest(memberKey) });
      await this.store.write(result.room);
      this.rooms.set(id, result.room);
      return { ...result, memberKey };
    });
  }
  async wishes(id, memberId, input) {
    return this.mutate(id, undefined, async (room) => {
      const next = submitWishes(room, { memberId, revision: input.revision, items: input.items });
      await this.store.write(next);
      this.rooms.set(id, next);
      return next;
    });
  }
  async invite(id, version) {
    return this.mutate(id, version, async (room) => {
      if (room.phase !== "collecting") throw new RoomError("ROOM_LOCKED", "仅收集中的餐桌可以更新邀请。");
      const joinKey = secret();
      return { room: await this.save(room, { joinHash: digest(joinKey) }), joinKey };
    });
  }
  async reopen(id, version) {
    return this.mutate(id, version, async (room) => {
      const next = reopenRoom(room);
      await this.store.write(next);
      this.rooms.set(id, next);
      return next;
    });
  }
  async plan(id, version) {
    return this.mutate(id, version, async (room) => {
      let frozen;
      if (room.phase === "collecting") frozen = freezeRoom(room);
      else if (["planned", "confirmed"].includes(room.phase)) {
        frozen = changed(room, { phase: "planning", plans: [], confirmation: null });
      } else throw new RoomError("ROOM_LOCKED", "当前订单状态不允许重新计算。");
      await this.store.write(frozen);
      this.rooms.set(id, frozen);
      try {
        const pool = offerPool(frozen.catalog, frozen.locked.demand);
        const result = buildPlans({ demand: frozen.locked.demand, offers: pool.offers, limit: 8, maxStates: 20000 });
        const verified = [];
        let attempted = 0;
        for (const candidate of result.plans) {
          if (!supportedCart(candidate)) continue;
          try {
            makeDesk(frozen, candidate);
            attempted += 1;
            const quote = normalizeQuote(
              await this.gateway.call("calculate-price", quoteArgs(frozen, candidate.items)), candidate, frozen);
            verified.push({ ...candidate, quote });
          } catch (error) {
            if (error.uncertain || error.code === "HTTP_401") break;
          }
        }
        verified.sort((a, b) => a.quote.priceCents - b.quote.priceCents ||
          a.extras.reduce((sum, item) => sum + item.quantity, 0) -
          b.extras.reduce((sum, item) => sum + item.quantity, 0));
        const next = await this.save(frozen, {
          phase: "planned", plans: verified,
          search: {
            ...result.search, ...pool.coverage, attemptedPlans: attempted, verifiedPlans: verified.length,
            candidatePlans: result.plans.length,
          },
          review: verified.length ? null : { message: "没有取得满足意愿的成功报价，请重新核对菜单或重新收集。" },
        });
        return next;
      } catch (error) {
        await this.save(frozen, {
          phase: "planned", plans: [], review: { message: "本轮组合计算未完成，可重新计算或重新收集。" },
        });
        throw error;
      }
    });
  }
  select(id, input) {
    return this.mutate(id, input.version, (room) => confirmPlan(this, room, input));
  }
  order(id, input) {
    return this.mutate(id, input.version, (room) => startOrder(this, room, input));
  }
  verify(id) {
    return this.mutate(id, undefined, (room) => checkPayment(this, room));
  }
  recover(id, input) {
    return this.mutate(id, input.version, (room) => recoverOrder(this, room, input));
  }
  release(id, input) {
    return this.mutate(id, input.version, async (room) => {
      if (!["creation-unknown", "creation-rejected"].includes(room.phase) ||
          input.confirmNoOrder !== true || room.order?.orderId) {
        throw new RoomError("RECONCILIATION_REQUIRED", "请先核对官方订单；有已知订单号时必须核对该订单状态。");
      }
      return this.save(room, {
        phase: "planned", confirmation: null, attempt: null, review: {
          message: "已按你确认无单的声明解除，请重新核价和确认。若官方实际有订单，请停止操作避免重复。",
        },
      });
    });
  }
  desk(id) {
    const room = this.room(id);
    if (room.phase !== "intaken" || !room.desk || !room.review?.verifiedPaid) {
      throw new RoomError("PAID_REQUIRED", "官方支付与餐品尚未核实，不能进入开袋台。");
    }
    return { desk: room.desk, deskVersion: room.deskVersion, review: { ...room.review, mode: this.gateway.mode } };
  }
  deskAction(id, input) {
    return this.mutate(id, undefined, async (room) => {
      this.desk(id);
      if (room.deskVersion !== input.deskVersion) {
        throw new RoomError("DESK_CHANGED", "开袋记录已被其他页面更新，请刷新。");
      }
      const desk = reduceDesk(room.desk, input.action);
      if (desk === room.desk) return this.desk(id);
      const next = await this.save(room, { desk, deskVersion: room.deskVersion + 1 });
      return { desk: next.desk, deskVersion: next.deskVersion, review: { ...next.review, mode: this.gateway.mode } };
    });
  }
}
