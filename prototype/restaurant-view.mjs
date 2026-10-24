import { h, button as b, pill } from "./render.mjs";
import { storeMapUrl } from "./place-media.mjs";

export function addressCard(address) {
  return h("div", { class: "delivery-address" },
    h("strong", {}, address.fullAddress),
    h("p", {}, `${address.contactName} · ${address.phone}`));
}

export function restaurantForm(state) {
  const delivery = state.fulfillment === "delivery";
  return h("section", { class: "panel" }, h("h2", {}, "这次怎么取餐？"),
    h("div", { class: "fulfillment-options", role: "group", "aria-label": "取餐方式" },
      h("button", { type: "button", class: "btn", disabled: state.busy,
        "aria-pressed": String(!delivery), data: { action: "fulfillment", id: "pickup" } }, "外带自取"),
      h("button", { type: "button", class: "btn", disabled: state.busy,
        "aria-pressed": String(delivery), data: { action: "fulfillment", id: "delivery" } }, "麦乐送到家")),
    delivery ? h("div", { class: "group-form" },
      state.addresses.length ? h("form", { class: "group-form", data: { form: "delivery-stores" } },
        h("fieldset", { class: "store-picker" }, h("legend", {}, "选择已有收货地址"),
          state.addresses.map((address) => h("label", { class: "address-choice" },
            h("input", { type: "radio", name: "addressId", value: address.addressId,
              checked: state.addressId === address.addressId, required: true }),
            addressCard(address)))),
        b("查看可配送餐厅", { type: "submit", variant: "primary", disabled: state.busy }))
        : h("p", { class: "note" }, state.addressesLoaded
          ? "账户暂未返回可用地址，请先在麦当劳官方渠道保存收货地址，再刷新。"
          : "读取已有收货地址后直接选择，地址和电话只给点餐员查看。"),
      b("刷新已有地址", { action: "addresses", disabled: state.busy }))
      : h("div", { class: "group-form" },
        h("div", { class: "group-actions" },
          b("我的收藏餐厅", { action: "favorites", disabled: state.busy }),
          b("使用我的位置", { action: "geolocate", disabled: state.busy }),
          b("按地标找店", { action: "manual-location", disabled: state.busy })),
        state.config.geolocationConfigured && h("p", { class: "muted" },
          "点“使用我的位置”才申请授权；坐标发给高德转换地点，再向麦当劳查附近门店，不保存坐标。"),
        state.locationNotice && h("p", { class: "note" }, state.locationNotice),
        state.manualSearch && h("form", { class: "group-form", data: { form: "stores" } },
          h("label", {}, "城市", h("input", { name: "city", value: state.city, maxlength: 80, required: true, placeholder: "所在城市" })),
          h("label", {}, "附近地标", h("input", { name: "keyword", value: state.keyword, maxlength: 80, required: true, placeholder: "商场、街道或办公楼" })),
          b("查附近餐厅", { type: "submit", variant: "primary", disabled: state.busy }))),
    state.stores.length > 0 && h("form", { class: "group-form", data: { form: "create" } },
      h("fieldset", { class: "store-picker" }, h("legend", {}, delivery ? "可向所选地址配送" : "选择这次点餐的餐厅"),
        h("div", { class: "store-grid" }, state.stores.map((store, index) => h("article", { class: "store-card" },
          h("label", { class: "store-choice" },
            h("input", { type: "radio", name: "storeCode", value: store.selectionKey ?? store.storeCode, required: true,
              checked: state.selectedStore === (store.selectionKey ?? store.storeCode), disabled: !store.businessStatus }),
            h("strong", {}, store.storeName)),
          pill(store.businessStatus ? "success" : "pending", store.businessStatus ? "接口显示营业中" : "暂停营业"),
          store.address && h("p", {}, store.address),
          h("p", { class: "store-distance" }, store.distanceLabel ??
            (store.distance !== null && store.distance !== undefined
              ? `官方距离值 ${store.distance}（接口未注明单位）` : "距离暂未提供")),
          index === 0 && store.businessStatus && h("p", { class: "muted" },
            store.distanceLabel ? "优先展示：距离较近且当前营业" : "可先查看这家餐厅"),
          (store.businessStartTime || store.businessEndTime) &&
            h("p", { class: "muted" }, `营业：${store.businessStartTime || "未提供"} — ${store.businessEndTime || "未提供"}`),
          state.config.mode === "live" && h("a", {
            class: "btn", href: storeMapUrl(store), target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer",
          }, "地图查看"))))),
      h("details", {}, h("summary", {}, "给餐桌起个名字（可选）"),
        h("label", { class: "group-form" }, "餐桌名称", h("input", { name: "title", value: state.title, maxlength: 80, placeholder: "默认：一起点餐" }))),
      h("p", { class: "muted" }, "确认餐厅后读取真实单品与套餐详情。建桌不会创建订单。"),
      b("选这家，读取菜单", { type: "submit", variant: "primary", disabled: state.busy })));
}
