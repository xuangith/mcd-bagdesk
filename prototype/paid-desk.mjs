import { h, button } from "./render.mjs";
import { restoreDesk } from "./state.mjs";
import { json, ApiError } from "./group-shared.mjs";

export function setupPaidDesk({ onLoad, onError, onStatus }) {
  const id = new URLSearchParams(location.hash.slice(1)).get("receipt");
  if (!id) return null;
  let secret = "", revision = 0, generation = 0;
  const adapter = { active: true, ready: false, busy: false };
  const panel = h("section", { class: "panel" },
    h("h2", {}, "连接这桌的开袋记录"),
    h("p", { class: "muted" }, "仅点餐员可查看和更新已付款餐桌；管理口令在启动终端里。"));
  const form = h("form", { class: "add-form" },
    h("label", { for: "paid-key" }, "本机管理口令"),
    h("input", { id: "paid-key", name: "key", type: "password", required: true, autocomplete: "current-password" }),
    button("连接已付款清单", { type: "submit", variant: "primary" }));
  panel.append(form);
  document.getElementById("main").prepend(panel);
  const endpoint = `/api/rooms/${id}/desk`;
  const headers = () => ({ "X-Organizer-Key": secret });
  function accept(result) {
    if (!result.review?.verifiedPaid || !Number.isInteger(result.deskVersion)) {
      throw new ApiError("PAID_REQUIRED", "未取得官方支付核验结果，不能加载这张清单。");
    }
    const desk = restoreDesk(result.desk);
    revision = result.deskVersion;
    adapter.mode = result.review.mode;
    adapter.ready = true;
    panel.hidden = true;
    onLoad(desk);
  }
  async function connect(key) {
    if (!/^[a-f0-9-]{36}$/.test(id)) { onError(new Error("餐桌链接无效。")); return; }
    const current = ++generation;
    secret = key;
    adapter.busy = true;
    onStatus();
    try {
      const result = await json(endpoint, { headers: headers() });
      if (!adapter.active || current !== generation) return;
      accept(result);
      form.elements.key.value = "";
    } catch (error) {
      if (adapter.active && current === generation) { panel.hidden = false; onError(error); }
    } finally {
      if (adapter.active && current === generation) { adapter.busy = false; onStatus(); }
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!adapter.busy) void connect(form.elements.key.value);
  });
  adapter.dispatch = async (action) => {
    if (!adapter.ready || adapter.busy) throw new ApiError("DESK_BUSY", "请先完成连接或等待本次操作。");
    adapter.busy = true; onStatus();
    try {
      const result = await json(endpoint, {
        method: "POST", headers: headers(), body: { deskVersion: revision, action },
      });
      if (!adapter.active) throw new ApiError("DESK_LEFT", "已离开关联餐桌。");
      accept(result);
      return result.desk;
    } catch (error) {
      if (adapter.active) {
        try { accept(await json(endpoint, { headers: headers() })); } catch { /* 不重放写操作。 */ }
      }
      throw error;
    } finally {
      adapter.busy = false;
      if (adapter.active) onStatus();
    }
  };
  adapter.detach = () => {
    adapter.active = false; generation += 1; secret = ""; panel.remove();
    history.replaceState(null, "", location.pathname);
  };
  let transferred = "";
  try {
    transferred = sessionStorage.getItem(`bagdesk-organizer-transfer:${id}`) ?? "";
    sessionStorage.removeItem(`bagdesk-organizer-transfer:${id}`);
  } catch { /* 没有可用交接时由点餐员输入口令。 */ }
  queueMicrotask(() => { if (transferred) void connect(transferred); else onStatus(); });
  return adapter;
}
