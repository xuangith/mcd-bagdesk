import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DemoGateway } from "../demo-gateway.mjs";
import { RoomStore } from "../room-store.mjs";
import { GroupService } from "../group-service.mjs";

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "bagdesk-group-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = new DemoGateway();
  const store = new RoomStore(directory);
  const service = new GroupService(gateway, store);
  await service.initialize();
  await service.searchStores("演示", "合成");
  const created = await service.create({ title: "测试餐桌", storeCode: "900001" });
  return { directory, gateway, store, service, ...created };
}

export async function readyOrder(t) {
  const context = await fixture(t);
  const { service } = context;
  const first = await service.join(context.room.id, { name: "小林" });
  await service.wishes(context.room.id, first.member.id, {
    revision: 0, items: [{ sku: "1440", quantity: 1 }, { sku: "4810", quantity: 1 }],
  });
  const second = await service.join(context.room.id, { name: "小周" });
  await service.wishes(context.room.id, second.member.id, {
    revision: 0, items: [{ sku: "1440", quantity: 1 }, { sku: "4810", quantity: 1 }],
  });
  const planned = await service.plan(context.room.id, service.room(context.room.id).version);
  const plan = planned.plans[0];
  const selected = await service.select(planned.id, {
    version: planned.version, planId: plan.id, takeWayCode: plan.quote.takeWays[0].code,
  });
  return {
    ...context, room: selected.room, nonce: selected.nonce, plan,
    members: [first.member, second.member],
  };
}
