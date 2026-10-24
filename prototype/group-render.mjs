import { h, button as b, pill } from "./render.mjs";
import { money, phases } from "./group-shared.mjs";
import { storeMapUrl } from "./place-media.mjs";
import { restaurantForm, addressCard } from "./restaurant-view.mjs";

const text = (room, sku) => room.menu.find((item) => item.sku === sku)?.name ?? "菜单中已无此单品";
const field = (label, { name, value = "", type = "text", required = true, ...props }) =>
  h("label", {}, label, h("input", { name, value, type, required, autocomplete: "off", ...props }));
const box = (title, ...children) => h("section", { class: "panel" }, h("h2", {}, title), children);
const list = (items) => h("ul", { class: "group-list" }, items);
const wishText = (room, wishes) => wishes.length
  ? wishes.map((item) => `${text(room, item.sku)} × ${item.quantity}`).join("；") : "本次不点餐";

function invitation(state) {
  const room = state.room;
  if (room.phase !== "collecting") return null;
  const link = state.joinKey ? `${state.origin}/join.html#room=${room.id}&join=${state.joinKey}` : "";
  return box("邀请同局域网的同事一起选餐",
    state.config.shareOrigins?.length > 0 && h("label", {}, "局域网访问地址",
      h("select", { id: "share-origin", value: state.origin },
        state.config.shareOrigins.map((origin) => h("option", { value: origin, selected: origin === state.origin }, origin)))),
    state.config.shareOrigins?.length === 0 && h("p", { class: "note" }, "当前没有识别到可共享的局域网地址，邀请只能在本机体验。"),
    link && h("label", { class: "group-form" }, "邀请链接", h("input", { id: "invite-link", value: link, readonly: true })),
    h("div", { class: "group-actions" },
      link && b("复制邀请链接", { action: "copy-invite", disabled: state.busy }),
      link && h("a", { class: "btn", href: link, target: "_blank", rel: "noopener noreferrer" }, "打开成员视角"),
      b(link ? "更新邀请" : "生成邀请链接", { action: "invite", disabled: state.busy })),
    h("p", { class: "muted" }, "同一可互通局域网的电脑、平板或手机均可打开，支持有线与无线连接。成员只选单品，系统搭配套餐。"));
}

function members(state) {
  const room = state.room;
  const waiting = room.members.filter((member) => !member.submitted).length;
  return box("大家想吃什么",
    h("p", { class: "group-kicker" }, `${room.members.length - waiting}/${room.members.length} 人已提交`),
    room.members.length ? list(room.members.map((member) => h("li", {},
      h("div", { class: "group-actions" }, h("strong", {}, member.name),
        pill(member.submitted ? "success" : "pending", member.submitted ? "已提交" : "还未提交")),
      h("p", {}, member.submitted ? wishText(room, member.wishes) : "等待这位选餐；不点餐也可以提交空清单。"))))
      : h("p", { class: "muted" }, "还没有成员加入。先分享邀请链接。"),
    ["collecting", "planned", "confirmed"].includes(room.phase) && h("div", { class: "group-actions" },
      b(room.phase === "collecting" ? "截止收集并找买法" : "重新核价", {
        action: "plan", variant: "primary", disabled: state.busy || !room.members.length || waiting > 0,
      }),
      room.phase !== "collecting" && b("重新收集意愿", { action: "reopen", disabled: state.busy })),
    waiting > 0 && h("p", { class: "muted" }, "等所有已加入成员提交后再计算，避免漏掉某一位。"));
}

function planCard(state, plan, index) {
  const room = state.room;
  return h("article", { class: "group-box" },
    h("div", { class: "group-actions" }, h("h3", {}, index === 0 ? "本轮已核价候选中最低" : `候选 ${index + 1}`),
      room.selectedPlanId === plan.id && pill("success", "当前选择")),
    h("p", { class: "group-price" }, money(plan.quote.priceCents)),
    room.fulfillment === "delivery" && h("p", { class: "muted" },
      `含配送费 ${money(plan.quote.deliveryCents)}${plan.quote.packingCents === null ? "" : ` · 包装费 ${money(plan.quote.packingCents)}`}`),
    list(plan.quote.products.map((item) => h("li", {}, `${item.name} × ${item.quantity}`))),
    h("p", { class: "group-extras" }, plan.extras.length
      ? `多出的餐品，尚未分配：${plan.extras.map((item) => `${item.name} × ${item.quantity}`).join("；")}`
      : "没有多出的餐品"),
    h("p", { class: "muted" }, `核价于 ${new Date(plan.quote.quotedAt).toLocaleTimeString("zh-CN")}，创建前会再次核对。`),
    ["planned", "confirmed"].includes(room.phase) && h("form", {
      class: "group-form", data: { form: "select", id: plan.id },
    }, room.fulfillment === "delivery" ? h("p", {}, "麦乐送到家 · 使用本桌已选地址") :
    h("label", {}, "取餐方式", h("select", { name: "takeWayCode", required: true },
      h("option", { value: "" }, "请选择"),
      plan.quote.takeWays.map((way) => h("option", { value: way.code, selected: /外带/.test(way.title) }, way.title)))),
    b("选择这份餐单", { type: "submit", variant: index === 0 ? "primary" : "secondary", disabled: state.busy })));
}

function plans(state) {
  const room = state.room;
  if (!room.plans.length) return null;
  return box("套餐和单品，怎样组合更合适",
    h("p", {}, state.config.mode === "demo"
      ? `本轮 ${room.search?.verifiedPlans ?? room.plans.length} 个候选使用合成报价，仅用于演示。`
      : `本轮成功核价 ${room.search?.verifiedPlans ?? room.plans.length} 个候选。以下金额来自官方整单核价。`),
    (room.search?.truncated || room.search?.variantsTruncated) &&
      h("p", { class: "note" }, "本轮采用有界搜索，未覆盖全部可选组合；最低金额只在已核价候选间比较。"),
    h("div", { class: "group-grid" }, room.plans.map((plan, index) => planCard(state, plan, index))));
}

function confirmation(state) {
  const room = state.room;
  if (room.phase !== "confirmed") return null;
  const plan = room.plans.find((item) => item.id === room.selectedPlanId);
  if (!plan) return null;
  return box("点餐员最后核对",
    h("p", { class: "group-price" }, `${state.config.mode === "demo" ? "合成演示金额" : "官方核价"} ${money(plan.quote.priceCents)}`),
    h("p", {}, `${room.store.storeName} · ${room.fulfillment === "delivery" ? "麦乐送到家" : state.takeWayTitle || "请重新选择取餐方式"}`),
    room.fulfillment === "delivery" && (room.deliveryAddress
      ? addressCard(room.deliveryAddress) : h("p", { class: "note" }, "请刷新并核对收货地址，不能在地址不明时下单。")),
    list(room.locked.perMember.map((member) => h("li", {}, h("strong", {}, member.name), wishText(room, member.wishes)))),
    h("p", { class: "group-extras" }, plan.extras.length
      ? `额外餐品：${plan.extras.map((item) => `${item.name} × ${item.quantity}`).join("；")}` : "没有额外餐品"),
    state.nonce ? h("form", { class: "group-form", data: { form: "order" } },
      h("label", { class: "check-label" },
        h("input", { type: "checkbox", name: "ack", required: true }),
        room.fulfillment === "delivery" ? "我已核对餐品、金额、门店、收货地址和联系方式" :
          "我已核对每人的餐品、额外内容、金额、门店和取餐方式"),
      b("确认并创建待支付订单", { type: "submit", variant: "primary", disabled: state.busy }))
      : h("p", { class: "note" }, "本页没有有效的确认凭据，请重新选择餐单与取餐方式。"));
}

function orderState(state) {
  const room = state.room;
  if (!["creating", "awaiting-payment", "creation-unknown", "creation-rejected", "cancelled", "paid-review", "intaken"].includes(room.phase)) return null;
  return box(phases[room.phase] ?? "订单状态待核对",
    room.orderId && h("p", { class: "group-id" }, `订单号：${room.orderId}`),
    room.review?.message && h("p", { class: "note" }, room.review.message),
    h("div", { class: "group-actions" },
      room.paymentUrl && b(state.config.mode === "demo" ? "查看合成支付链接" : "打开官方支付页", { action: "pay", variant: "primary" }),
      room.orderId && !room.receiptReady && b("我已付款，核对状态", { action: "verify", disabled: state.busy }),
      state.config.mode === "demo" && room.orderId && !room.receiptReady &&
        b("模拟已付款（不收费）", { action: "demo-paid", disabled: state.busy }),
      room.receiptReady && b("进入开袋台", { action: "desk", variant: "primary" })),
    ["creation-unknown", "creation-rejected"].includes(room.phase) &&
      h("form", { class: "group-form", data: { form: "recover" } },
        field("从官方订单中找到本次订单号", { name: "orderId", maxlength: 100 }),
        b("用订单号核对", { type: "submit", disabled: state.busy })),
    ["creation-unknown", "creation-rejected"].includes(room.phase) && !room.orderId &&
      h("details", {}, h("summary", {}, "已在官方核实没有这笔订单？"),
        h("p", { class: "note" }, "只有确认官方账户中没有本次订单才能解除。如果实际已创建，再下单会重复。"),
        h("form", { class: "group-form", data: { form: "release" } },
          h("label", { class: "check-label" }, h("input", { type: "checkbox", name: "ack", required: true }),
            "我已在官方订单中核实，没有本次订单"),
          b("解除后重新核价", { type: "submit", variant: "danger", disabled: state.busy }))));
}

export function renderGroup(state) {
  const children = [
    h("div", { class: "group-heading" }, h("h1", {}, state.room?.title ?? "先说想吃的，套餐交给系统"),
      h("p", { class: "muted" }, "成员选单品，点餐员统一确认付款，收餐后接着清点和递餐。")),
    state.config?.mode === "demo" && h("p", { class: "group-source" }, "合成演示：不是实际菜单，模拟付款不会收费。"),
    state.error && h("p", { class: "group-error", role: "alert" }, state.error),
    state.message && h("p", { class: "feedback", role: "status" }, state.message),
    state.busy && h("p", { class: "note", role: "status" }, "正在读取菜单或核对官方结果，请稍候；不会自动重复下单。"),
  ];
  if (!state.authenticated) {
    children.push(box("点餐员工作台",
      h("form", { class: "group-form", data: { form: "login" } },
        field("启动终端显示的本机管理口令", { name: "key", type: "password", autocomplete: "current-password" }),
        b("进入工作台", { type: "submit", variant: "primary", disabled: state.busy }))));
  } else {
    children.push(h("div", { class: "group-actions" },
      b("刷新状态", { action: "refresh", disabled: state.busy }),
      state.room && b("新建/切换餐桌", { action: "back", disabled: state.busy })));
    if (state.room) {
      children.push(pill("pending", phases[state.room.phase] ?? "状态待核对"),
        box("本桌餐厅", h("strong", {}, state.room.store.storeName),
          h("p", {}, state.room.fulfillment === "delivery" ? "麦乐送到家" : "外带自取"),
          h("p", {}, state.room.store.address || "官方未返回地址"),
          state.config.mode === "live" && h("a", {
            class: "btn", href: storeMapUrl(state.room.store), target: "_blank", rel: "noopener noreferrer",
            referrerpolicy: "no-referrer",
          }, "在高德地图核对位置"),
          state.room.fulfillment === "delivery" && state.room.deliveryAddress && addressCard(state.room.deliveryAddress)),
        invitation(state),
        members(state), plans(state), confirmation(state), orderState(state));
    } else {
      children.push(restaurantForm(state), box("已有餐桌", state.rooms.length ? list(state.rooms.map((room) =>
        h("li", {}, h("strong", {}, room.title), h("span", {}, `${room.storeName} · ${phases[room.phase] ?? "状态待核对"}`),
          b("打开餐桌", { action: "room", id: room.id, disabled: state.busy }))))
        : h("p", { class: "muted" }, "还没有餐桌，先选择门店。")));
    }
  }
  return children.filter(Boolean);
}
