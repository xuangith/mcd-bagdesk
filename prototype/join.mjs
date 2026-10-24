import { h, button as b, pill } from "./render.mjs";
import { json, money, groups, phases } from "./group-shared.mjs";
import { menuPhoto } from "./menu-photo.mjs";
import { storeMapUrl } from "./place-media.mjs";

const app = document.getElementById("join-app");
const fragment = new URLSearchParams(location.hash.slice(1));
const roomId = fragment.get("room") ?? "";
const joinKey = fragment.get("join") ?? "";
const storageKey = `bagdesk-member:${roomId}`;
let memberKey = "";
try { memberKey = sessionStorage.getItem(storageKey) ?? ""; } catch { /* 当前页仍可用，刷新需重新加入。 */ }
const state = { room: null, mode: null, chosen: new Map(), group: "all", query: "", busy: false, error: "", message: "", dirty: false, conflict: false };
const endpoint = (name) => `/api/rooms/${roomId}/${name}`;
const auth = () => ({ "X-Member-Key": memberKey });
const total = () => [...state.chosen.values()].reduce((sum, quantity) => sum + quantity, 0);
const editable = () => state.room?.phase === "collecting" && !state.busy && !state.conflict;

function quantityControl(item) {
  const value = state.chosen.get(item.sku) ?? 0;
  const control = (label, action, accessible, disabled) => h("button", {
    type: "button", class: "btn", disabled, "aria-label": accessible,
    data: { action, id: item.sku, key: `${action}:${item.sku}` },
  }, label);
  return h("div", { class: "menu-counter" },
    control("−", "minus", `减少${item.name}`, !editable() || value === 0),
    h("label", { class: "sr", for: `quantity-${item.sku}` }, `${item.name}的份数`),
    h("input", { id: `quantity-${item.sku}`, type: "number", min: 0, max: 50, step: 1,
      inputmode: "numeric", value, disabled: !editable(), data: { sku: item.sku, key: `quantity:${item.sku}` } }),
    control("+", "plus", `增加${item.name}`, !editable() || total() >= 50));
}

function paint(preferredFocus) {
  const active = document.activeElement;
  const focus = preferredFocus ?? active?.dataset?.key;
  const position = active?.id === "menu-search" ? active.selectionStart : null;
  const room = state.room;
  const children = [
    h("div", { class: "group-heading" }, h("h1", {}, room?.title ?? "打开邀请，选你想吃的"),
      room && h("p", { class: "muted" }, room.storeName),
      room?.store?.address && h("p", { class: "muted" }, room.store.address),
      room?.store && state.mode === "live" && h("a", {
        class: "store-map-link", href: storeMapUrl(room.store), target: "_blank",
        rel: "noopener noreferrer", referrerpolicy: "no-referrer",
      }, "在高德地图核对餐厅位置")),
    state.error && h("p", { class: "group-error", role: "alert" }, state.error),
    state.message && h("p", { class: "feedback", role: "status" }, state.message),
    state.busy && h("p", { class: "note", role: "status" }, "正在提交或刷新，请稍候。"),
  ];
  if (!room) {
    children.push(b("重新打开邀请", { action: "reload", variant: "primary", disabled: state.busy }));
  } else if (!room.me) {
    children.push(h("section", { class: "panel" }, h("h2", {}, "怎么称呼你？"),
      h("p", {}, "加入后只选单品和份数，由点餐员搭配套餐、统一确认并付款。"),
      h("form", { class: "group-form", data: { form: "join" } },
        h("label", {}, "让点餐员认得出的昵称", h("input", { name: "name", maxlength: 80, required: true, autocomplete: "nickname" })),
        b("加入餐桌", { type: "submit", key: "join-submit", variant: "primary", disabled: state.busy || room.phase !== "collecting" }))));
  } else {
    const menu = room.menu;
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    const visible = menu.filter((item) => query ? item.name.toLocaleLowerCase("zh-CN").includes(query) :
      state.group === "all" || item.menuGroup === state.group || (!item.menuGroup && state.group === "other"));
    children.push(
      h("div", { class: "group-actions" }, pill("pending", phases[room.phase] ?? "状态待核对"),
        h("span", {}, `${room.me.name} · ${room.submittedCount}/${room.memberCount} 人已提交`),
        b("刷新状态", { action: "refresh", disabled: state.busy })),
      h("p", { class: "note" }, "这里提交的是单品意愿，不是订单。套餐、额外餐品和最终金额由点餐员统一核对。"),
      state.conflict && h("p", { class: "note" }, "本页改动未提交，请先刷新并核对服务器上已提交的版本。"),
      h("section", { class: "panel menu-tools" }, h("h2", {}, "从单品里挑"),
        h("label", {}, "搜索餐品名称", h("input", {
          id: "menu-search", type: "search", value: state.query, placeholder: "例如：汉堡、薯条、可乐",
          data: { key: "search" },
        })),
        h("nav", { class: "menu-tabs", "aria-label": "餐品分类" }, groups.map(([key, label]) => h("button", {
          type: "button", class: "btn", "aria-pressed": String(!query && state.group === key),
          data: { action: "category", id: key, key: `category:${key}` },
        }, label, h("small", {}, key === "all" ? menu.length : menu.filter((item) => item.menuGroup === key).length)))),
        h("p", { class: "muted" }, query ? `跨分类找到 ${visible.length} 项` :
          "按门店默认规格选择；菜单价为参考价，最终由点餐员整单核价。"),
        h("div", { class: "menu-items" }, visible.length ? visible.map((item, index) => h("article", {
          class: `menu-item${state.chosen.get(item.sku) ? " chosen" : ""}`, data: { sku: item.sku },
        }, menuPhoto(item, index < 4), h("h3", {}, item.name),
        h("p", { class: "muted" }, `菜单参考 ${money(item.estimatedCents)}`), quantityControl(item)))
          : h("p", { class: "muted" }, "没有符合这个分类或名称的单品，试试其他分类或清空搜索。"))),
      h("section", { class: "wish-summary" }, h("h2", {}, "我想要的"),
        total() ? h("ul", {}, [...state.chosen].filter(([, count]) => count > 0).map(([sku, count]) => {
          const item = menu.find((product) => product.sku === sku);
          return h("li", {}, h("strong", {}, item?.name ?? "当前菜单已无此单品"),
            h("span", {}, `× ${count}`), b("移除", { action: "remove", id: sku, disabled: !editable() }));
        })) : h("p", { class: "muted" }, "还没选择；不点餐也可以明确提交。"),
        h("p", { class: "muted" }, state.dirty ? "本页选择有未提交的改动。" :
          room.me.submitted ? "以上为你已提交的意愿。" : "选择后按下方按钮提交。")),
      h("form", { class: "member-submit", data: { form: "wishes" } },
        h("p", {}, `已选 ${total()} 份单品`),
        b(total() ? "提交这份意愿" : "本次不点餐并提交", {
          type: "submit", key: "submit-wishes", variant: "primary", disabled: !editable(),
        })));
  }
  app.replaceChildren(...children.filter(Boolean));
  if (focus) {
    const target = app.querySelector(`[data-key="${CSS.escape(focus)}"]`) ??
      (focus === "join-submit" ? document.getElementById("menu-search") : null);
    if (target && !target.disabled) target.focus();
  }
  if (position !== null) document.getElementById("menu-search")?.setSelectionRange(position, position);
}

function useRoom(room, keepDraft = false) {
  state.room = room;
  if (!keepDraft && room.me) {
    state.chosen = new Map(room.me.wishes.map((item) => [item.sku, item.quantity]));
    state.dirty = false; state.conflict = false;
  }
}
async function load() {
  if (!/^[a-f0-9-]{36}$/.test(roomId)) throw new Error("邀请中没有有效餐桌，请向点餐员索取完整链接。");
  const config = await json("/api/config");
  state.mode = config.mode;
  document.getElementById("member-mode").textContent = config.mode === "demo" ? "合成演示 · 不收费" : "真实门店 · 单品意愿";
  useRoom(memberKey ? await json(endpoint("me"), { headers: auth() }) :
    await json(endpoint("join"), { headers: { "X-Join-Key": joinKey } }));
}
async function work(action) {
  if (state.busy) return;
  const focused = document.activeElement?.dataset?.key;
  state.busy = true; state.error = ""; state.message = ""; paint();
  try { await action(); }
  catch (error) {
    state.error = error.message ?? "本次操作没有完成。";
    if (error.status === 409 && memberKey) {
      state.conflict = true;
      try { useRoom(await json(endpoint("me"), { headers: auth() }), true); } catch { /* 不重放意愿提交。 */ }
    }
  } finally { state.busy = false; paint(focused); }
}
app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (action === "reload") { void work(load); return; }
  if (action === "refresh") {
    if (state.dirty && !window.confirm("刷新会用已提交的意愿替换本页尚未提交的改动，继续吗？")) return;
    void work(load); return;
  }
  if (action === "category") { state.group = id; state.query = ""; paint(); return; }
  if (!editable()) return;
  const old = state.chosen.get(id) ?? 0;
  if (action === "plus" && total() < 50) state.chosen.set(id, old + 1);
  if (action === "minus") state.chosen.set(id, Math.max(0, old - 1));
  if (action === "remove") state.chosen.delete(id);
  state.dirty = true;
  paint();
});
app.addEventListener("input", (event) => {
  if (event.target.id === "menu-search") { state.query = event.target.value; paint(); }
});
app.addEventListener("change", (event) => {
  const sku = event.target.dataset.sku;
  if (!sku || !editable()) return;
  const value = Number(event.target.value);
  const previous = state.chosen.get(sku) ?? 0;
  if (!/^\d{1,2}$/.test(event.target.value) || !Number.isInteger(value) ||
      value < 0 || value > 50 || total() - previous + value > 50) {
    state.error = "份数应为0至50的整数，本次单品合计最多50份。"; paint(); return;
  }
  state.chosen.set(sku, value); state.dirty = true; paint();
});
app.addEventListener("submit", (event) => {
  const form = event.target;
  event.preventDefault();
  const data = new FormData(form);
  void work(async () => {
    if (form.dataset.form === "join") {
      const result = await json(endpoint("join"), { method: "POST", body: { joinKey, name: String(data.get("name") ?? "").trim() } });
      memberKey = result.memberKey;
      try { sessionStorage.setItem(storageKey, memberKey); } catch { /* 当前页身份仍在内存中。 */ }
      useRoom(result.room);
    } else if (form.dataset.form === "wishes") {
      useRoom(await json(endpoint("wishes"), {
        method: "PUT", headers: auth(), body: {
          revision: state.room.me.revision,
          items: [...state.chosen].filter(([, quantity]) => quantity > 0).map(([sku, quantity]) => ({ sku, quantity })),
        },
      }));
      state.message = "意愿已提交；收集截止前还可以修改。";
    }
  });
});
await work(load);
