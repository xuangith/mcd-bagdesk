// 应用动作：状态在内存中，所有业务规则交给 state.mjs / order.mjs。
import { createDesk, reduceDesk, summarize } from "./state.mjs";
import { demoOrder } from "./sample.mjs";
import { setupImport } from "./import-flow.mjs";
import { setupPaidDesk } from "./paid-desk.mjs";
import { addPersonForm, checklistView, countersView, orderInfo, peopleView, rowsView } from "./render.mjs";

const $ = (s) => document.querySelector(s);
const WHOLE = /^\d{1,3}$/;
let state = createDesk(demoOrder);
let paid = null;
const ui = { opened: false, stage: "count", drafts: {}, flash: null, addOpen: false, demoNote: false };

const say = (text) => { $("#feedback").textContent = text; $("#error").textContent = ""; };
const fail = (e) => { $("#error").textContent = e?.message || "操作失败，请重试。"; $("#feedback").textContent = ""; return false; };
const restoreFocus = (key) => { if (key) document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus(); };
const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? "";

function paint(focus) {
  const key = focus ?? document.activeElement?.dataset?.key;
  const sum = summarize(state);
  const synthetic = state.source === "synthetic";
  const remote = paid?.active;
  const locked = remote && (!paid.ready || paid.busy);
  const badge = $("#source-badge");
  $("#order-title").textContent = state.title;
  badge.textContent = synthetic ? "合成团餐演示 · 非真实订单" : "本地导入 · 仅内存处理";
  badge.className = `pill ${synthetic ? "pill-synthetic" : "pill-imported"}`;
  if (remote) {
    badge.textContent = paid.ready
      ? paid.mode === "demo" ? "合成已付款演示 · 未收费" : "官方已支付 · 关联餐桌"
      : "已付款清单待连接";
    $("#order-title").textContent = paid.ready ? state.title : "连接餐桌的开袋记录";
  }
  $("#bag").classList.toggle("open", ui.opened);
  $("#start").disabled = ui.opened;
  $("#undo").disabled = state.history.length === 0;
  $("#demo-short").disabled = !synthetic;
  $("#count-panel").hidden = ui.stage !== "count" || (remote && !paid.ready);
  $("#people-panel").hidden = ui.stage !== "people" || (remote && !paid.ready);
  $("#view-count").setAttribute("aria-pressed", String(ui.stage === "count"));
  $("#view-people").setAttribute("aria-pressed", String(ui.stage === "people"));
  $("#people-progress").textContent = `${sum.claimedPeople}/${sum.totalPeople}`;
  $("#checklist-body").replaceChildren(checklistView(sum, ui));
  $("#counters").replaceChildren(countersView(sum, ui));
  $("#rows").replaceChildren(rowsView(sum, ui));
  $("#people").replaceChildren(peopleView(state, sum, ui), addPersonForm(state, sum, ui), orderInfo(state));
  if (locked) {
    document.querySelectorAll("#rows button, #rows input, #people button, #people input").forEach((field) => { field.disabled = true; });
    $("#undo").disabled = true; $("#start").disabled = true;
  }
  document.querySelector('[data-action="import-open"]').disabled = Boolean(remote);
  $("#demo-short").disabled = !synthetic || Boolean(remote);
  document.querySelector(".memory-note").textContent = remote
    ? "已支付餐桌的点数与领取记录保存在点餐员电脑，并通过本机服务同步。"
    : "刷新或关闭页面会清空本轮记录。数据只留在当前页面，不会上传。";
  restoreFocus(key);
  ui.flash = null;
}

async function run(action, { flash = null, msg, focus, demoNote = false } = {}) {
  try {
    if (paid?.active) {
      await paid.dispatch(action);
    } else state = reduceDesk(state, action);
  } catch (e) { return fail(e); }
  ui.flash = flash;
  ui.demoNote = demoNote;
  if (action.type === "receive" || action.type === "receiveMany") ui.opened = true;
  say(msg);
  paint(focus);
  return true;
}

function load(next, msg) {
  state = next;
  Object.assign(ui, { opened: false, stage: "count", drafts: {}, flash: null, addOpen: false, demoNote: false });
  say(msg);
  paint();
}

function ask(title, text, okLabel) {
  const d = $("#confirm");
  const back = document.activeElement;
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  d.returnValue = "";
  return new Promise((resolve) => {
    d.addEventListener("close", () => { back?.focus?.(); resolve(d.returnValue === "ok"); }, { once: true });
    d.showModal();
  });
}

async function undo() {
  if (!state.history.length) return fail(new Error("没有可撤销的操作。"));
  await run({ type: "undo" }, { msg: "已撤销上一步操作。" });
}

function demoShort() {
  if (state.source !== "synthetic") return fail(new Error("“演示少一份”只适用于合成样例。"));
  const fries = state.items.find((it) => it.category === "fries");
  run({ type: "receiveMany", counts: state.items.map((it) => ({
    itemId: it.id, quantity: it.expected - (it === fries ? 1 : 0),
  })) }, {
    flash: { kind: "count", id: fries?.id }, demoNote: true,
    msg: "已载入合成情境：薯条少一份。可撤销这次演示，或补齐后继续递餐。",
  });
}

async function reset() {
  if ((state.history.length || state.source !== "synthetic")
    && !(await ask("恢复合成样例", "当前的点数、领取记录和导入内容都会清空，且无法撤销。", "恢复样例"))) return;
  if (paid?.active) { paid.detach(); paid = null; }
  load(createDesk(demoOrder), "已恢复合成样例，关联餐桌的服务器记录保持原样。");
}

const importActions = setupImport({
  getState: () => state,
  onImport: (next) => {
    load(next, "应收清单已生成。先点数，需要分发时切换到递餐记录。");
    ui.opened = true;
    ui.addOpen = true;
    paint();
  },
});

const actions = {
  ...importActions,
  open() { ui.opened = true; ui.flash = { kind: "open" }; say("餐袋已打开，验收清单已展开。请逐项点数并确认数量。"); paint(); $("#checklist").focus(); },
  clear: (id) => run({ type: "receive", itemId: id, quantity: null }, { flash: { kind: "count", id }, focus: `qty:${id}`, msg: `已将${nameOf(state.items, id)}恢复为未点数。` }),
  claim: (id) => run({ type: "claim", personId: id }, { flash: { kind: "hand", id }, focus: `return:${id}`, msg: `已把整份餐递给${nameOf(state.people, id)}。` }),
  return: (id) => run({ type: "return", personId: id }, { focus: `claim:${id}`, msg: `已退回${nameOf(state.people, id)}的整份餐。` }),
  undo, reset,
  "demo-short": demoShort,
  "view-count"() { ui.stage = "count"; paint(); },
  "view-people"() { ui.stage = "people"; paint(); },
};

const forms = {
  async receive(form) {
    const id = form.dataset.id;
    const raw = form.elements.qty.value.trim();
    if (!WHOLE.test(raw)) return fail(new Error("请输入 0–999 的整数后再确认数量。"));
    const qty = Number(raw);
    const draft = ui.drafts[id];
    delete ui.drafts[id];
    const ok = await run({ type: "receive", itemId: id, quantity: qty }, { flash: { kind: "count", id }, focus: `confirm:${id}`, msg: `已确认${nameOf(state.items, id)}实收 ${qty}。` });
    if (!ok) ui.drafts[id] = draft;
  },
  "add-person"(form) {
    const fd = new FormData(form);
    const wants = [];
    for (const it of state.items) {
      const raw = String(fd.get(`want-${it.id}`) ?? "0").trim();
      if (!WHOLE.test(raw)) return fail(new Error("份数请输入 0–999 的整数。"));
      if (Number(raw) > 0) wants.push({ itemId: it.id, quantity: Number(raw) });
    }
    const name = String(fd.get("name") ?? "").trim();
    ui.addOpen = true;
    run({ type: "addPerson", name, wants }, { focus: "person-name", msg: `已加入${name}，可以在上方递餐。` });
  },
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (el && !el.disabled) actions[el.dataset.action]?.(el.dataset.id);
});
document.addEventListener("submit", (ev) => {
  const form = forms[ev.target.dataset?.form];
  if (form) { ev.preventDefault(); form(ev.target); }
});
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset?.draft) ui.drafts[t.dataset.draft] = t.value;
});
document.addEventListener("toggle", (ev) => { if (ev.target.dataset?.details === "add") ui.addOpen = ev.target.open; }, true);
document.addEventListener("keydown", (ev) => {
  const typing = ev.target.closest?.("input, textarea, select, [contenteditable]");
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === "z" && !typing && !document.querySelector("dialog[open]")) {
    ev.preventDefault();
    undo();
  }
});
$("#theme").addEventListener("change", (ev) => {
  if (ev.target.value === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = ev.target.value;
});
paint();
paid = setupPaidDesk({
  onLoad: (next) => {
    state = next; ui.opened = true; ui.drafts = {};
    paint();
  },
  onError: (error) => fail(error),
  onStatus: () => paint(),
});
if (paid) paint();
