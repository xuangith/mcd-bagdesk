import { json, ApiError } from "./group-shared.mjs";
import { renderGroup } from "./group-render.mjs";
import { requestBrowserPosition } from "./location-ui.mjs";

const app = document.getElementById("group-app");
const state = {
  config: null, authenticated: false, key: "", rooms: [], room: null, stores: [],
  city: "", keyword: "", selectedStore: "", title: "今天一起点餐", origin: location.origin,
  joinKey: "", nonce: "", takeWayTitle: "", busy: false, error: "", message: "",
  fulfillment: "pickup", addresses: [], addressesLoaded: false, addressId: "",
  manualSearch: false, locationNotice: "",
};
const headers = () => ({ "X-Organizer-Key": state.key });
const path = (operation = "") => `/api/rooms/${state.room.id}${operation ? `/${operation}` : ""}`;
const paint = () => app.replaceChildren(...renderGroup(state));
function setRoom(room) {
  if (state.room?.version !== room.version) state.nonce = "";
  state.room = room;
}
async function refresh() {
  if (state.room) setRoom(await json(path(), { headers: headers() }));
  else state.rooms = (await json("/api/rooms", { headers: headers() })).rooms;
}
async function work(action) {
  if (state.busy) return;
  state.busy = true; state.error = ""; state.message = ""; paint();
  try { await action(); }
  catch (error) {
    state.error = error.message ?? "操作未完成。";
    if (state.authenticated && state.room) {
      try { await refresh(); } catch { /* 保留本次错误，不重放任何写操作。 */ }
    }
  } finally { state.busy = false; paint(); }
}
async function post(operation, body = { version: state.room.version }) {
  return json(path(operation), { method: "POST", headers: headers(), body });
}
const actions = {
  refresh: () => work(refresh),
  back: () => work(async () => { state.room = null; state.joinKey = ""; state.nonce = ""; await refresh(); }),
  room: (id) => work(async () => { state.joinKey = ""; setRoom(await json(`/api/rooms/${id}`, { headers: headers() })); }),
  invite: () => work(async () => {
    const result = await post("invite"); setRoom(result.room); state.joinKey = result.joinKey;
  }),
  plan: () => work(async () => { setRoom(await post("plan")); }),
  reopen: () => work(async () => { setRoom(await post("reopen")); }),
  verify: () => work(async () => { setRoom(await post("check-payment", {})); }),
  "demo-paid": () => work(async () => { setRoom(await post("demo-paid", {})); }),
  pay: () => {
    try {
      const url = new URL(state.room.paymentUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      window.open(url.href, "_blank", "noopener,noreferrer");
    } catch { state.error = "未取得安全的支付链接，请在官方订单中继续付款。"; paint(); }
  },
  desk: () => {
    try {
      sessionStorage.setItem(`bagdesk-organizer-transfer:${state.room.id}`, state.key);
      location.assign(`/#receipt=${state.room.id}`);
    } catch {
      state.error = "当前浏览器不能完成口令交接，请在开袋台重新输入管理口令。";
      paint();
    }
  },
  "copy-invite": async () => {
    const link = document.getElementById("invite-link");
    try {
      await navigator.clipboard.writeText(link.value);
      state.message = "邀请链接已复制。";
    } catch {
      link.select();
      state.message = "请复制输入框中的完整邀请链接。";
    }
    document.querySelector('[role="status"]')?.remove();
    const message = document.createElement("p");
    message.className = "feedback"; message.setAttribute("role", "status"); message.textContent = state.message;
    app.prepend(message);
  },
  fulfillment: (mode) => work(async () => {
    state.fulfillment = mode; state.stores = []; state.selectedStore = ""; state.locationNotice = "";
    if (mode === "delivery") {
      state.addresses = (await json("/api/addresses", { headers: headers() })).addresses;
      state.addressesLoaded = true;
      if (state.addresses.length === 1) state.addressId = state.addresses[0].addressId;
    }
  }),
  addresses: () => work(async () => {
    state.addresses = (await json("/api/addresses", { headers: headers() })).addresses;
    state.addressesLoaded = true;
  }),
  favorites: () => work(async () => {
    state.stores = (await json("/api/stores?source=favorites", { headers: headers() })).stores;
    state.selectedStore = "";
    if (!state.stores.length) {
      state.manualSearch = true;
      state.locationNotice = "没有返回收藏餐厅，可以按附近地标查找。";
    }
  }),
  "manual-location": () => { state.manualSearch = true; paint(); },
  geolocate: () => work(async () => {
    if (!state.config.geolocationConfigured) {
      state.locationNotice = "点餐员尚未配置地图服务。可以先选收藏餐厅或附近地标；本次不会读取位置。";
      return;
    }
    const position = await requestBrowserPosition();
    const located = await json("/api/location-stores", { method: "POST", headers: headers(), body: position });
    state.city = located.location.city; state.stores = located.stores; state.selectedStore = "";
    state.locationNotice = `${located.location.city}${located.location.area}附近 · 定位精度约 ${located.location.accuracyMeters} 米。${located.location.distanceNote}`;
  }),
};

app.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (control && !control.disabled) void actions[control.dataset.action]?.(control.dataset.id);
});
app.addEventListener("change", (event) => {
  if (event.target.id === "share-origin") { state.origin = event.target.value; paint(); }
  if (event.target.name === "storeCode") state.selectedStore = event.target.value;
  if (event.target.name === "addressId") state.addressId = event.target.value;
});
app.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const data = new FormData(form);
  const which = form.dataset.form;
  void work(async () => {
    switch (which) {
      case "login":
        state.key = String(data.get("key") ?? "");
        try {
          state.config = await json("/api/config", { headers: headers() });
          await refresh();
          state.authenticated = true;
          state.origin = state.config.shareOrigins?.[0] ?? location.origin;
        } catch (error) { state.key = ""; throw error; }
        break;
      case "stores":
        state.city = String(data.get("city") ?? "").trim();
        state.keyword = String(data.get("keyword") ?? "").trim();
        state.stores = (await json(`/api/stores?${new URLSearchParams({ city: state.city, keyword: state.keyword })}`,
          { headers: headers() })).stores;
        state.selectedStore = "";
        if (!state.stores.length) state.message = "这个关键词没有返回门店，试试附近地标或街道名称。";
        break;
      case "create": {
        state.title = String(data.get("title") ?? "").trim() || "一起点餐";
        const result = await json("/api/rooms", { method: "POST", headers: headers(), body: {
          title: state.title, storeCode: String(data.get("storeCode") ?? ""),
        } });
        setRoom(result.room); state.joinKey = result.joinKey; break;
      }
      case "select": {
        const takeWayCode = String(data.get("takeWayCode") ?? "");
        const plan = state.room.plans.find((item) => item.id === form.dataset.id);
        const result = await post("select", {
          version: state.room.version, planId: form.dataset.id, takeWayCode,
          ...(state.room.fulfillment === "delivery" ? { addressHash: state.room.deliveryAddress?.hash } : {}),
        });
        setRoom(result.room); state.nonce = result.nonce;
        state.takeWayTitle = plan.quote.takeWays.find((item) => item.code === takeWayCode)?.title ?? "";
        break;
      }
      case "order":
        if (!data.get("ack")) throw new ApiError("CONFIRM", "请先核对并勾选确认。");
        setRoom(await post("order", { version: state.room.version, nonce: state.nonce, confirmed: true }));
        break;
      case "recover":
        setRoom(await post("recover", { version: state.room.version, orderId: String(data.get("orderId") ?? "").trim() }));
        break;
      case "release":
        if (!data.get("ack")) throw new ApiError("CONFIRM", "请先在官方订单中核实。");
        setRoom(await post("release", { version: state.room.version, confirmNoOrder: true }));
        break;
      case "delivery-stores":
        state.addressId = String(data.get("addressId") ?? "");
        state.stores = (await json(`/api/stores?${new URLSearchParams({ mode: "delivery", addressId: state.addressId })}`,
          { headers: headers() })).stores;
        state.selectedStore = "";
        if (!state.stores.length) state.message = "这个地址当前没有可配送门店，请换一个已有地址。";
        break;
      default: throw new ApiError("FORM", "不支持这个操作。");
    }
  });
});
window.addEventListener("focus", () => {
  if (state.authenticated && state.room?.orderId && state.room.phase === "awaiting-payment" && !state.busy) {
    void actions.verify();
  }
});
try { state.config = await json("/api/config"); }
catch (error) { state.error = error.message; }
paint();
