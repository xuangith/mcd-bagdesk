// 安全 DOM 构造：所有文本经 textContent/createTextNode，不使用 innerHTML。
const SVG_NS = "http://www.w3.org/2000/svg";
export const CATEGORY = { burger: "汉堡", fries: "薯条", drink: "饮品", other: "其他" };
const STATUS = {
  pending: ["pending", "未点数"],
  short: ["warning", "缺件"],
  extra: ["warning", "超收"],
  matched: ["success", "已对齐"],
};
const PROPS = new Set(["value", "disabled", "checked", "selected"]);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "data") for (const [dk, dv] of Object.entries(v)) { if (dv != null) el.dataset[dk] = dv; }
    else if (k === "class") el.className = v;
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function icon(category, cls = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  const use = document.createElementNS(SVG_NS, "use");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#icon-${Object.hasOwn(CATEGORY, category) ? category : "other"}`);
  svg.append(use);
  return svg;
}

export const pill = (kind, text) => h("span", { class: `pill pill-${kind}` }, text);

export function button(label, { action, id, variant = "secondary", type = "button", key, disabled, describedby } = {}) {
  const dataKey = key ?? (action ? `${action}${id ? `:${id}` : ""}` : undefined);
  return h("button", { type, class: `btn btn-${variant}`, disabled, "aria-describedby": describedby, data: { action, id, key: dataKey } }, label);
}

const numCell = (label, value) => h("div", {}, h("dt", {}, label), h("dd", {}, value));
const stat = (label, value) => h("div", { class: "stat" }, h("dt", {}, label), h("dd", {}, value));
const flashed = (ui, kind, id) => ui.flash?.kind === kind && ui.flash.id === id;

export function countersView(sum, ui) {
  const [kind, text] = sum.receiptComplete
    ? ["success", "收齐：逐项应收等于实收"]
    : sum.pendingKinds
      ? ["pending", `还有 ${sum.pendingKinds} 种未点数，暂不能判断是否收齐`]
      : ["warning", `未收齐：缺 ${sum.shortageTotal} 件，多 ${sum.overageTotal} 件`];
  return h("div", { class: "counters" },
    h("p", { class: `banner banner-${kind}` }, text),
    ui.demoNote && h("p", { class: "note" }, "演示操作：已载入“少一份”情境，这是人工预设，不是系统自动发现漏装。可撤销或恢复样例。"),
    h("dl", { class: "stats" },
      stat("应收合计", sum.expectedTotal), stat("已点数实收", sum.receivedTotal), stat("已领出", sum.claimedTotal),
      stat("领取进度", `${sum.claimedPeople}/${sum.totalPeople}`)));
}

export function checklistView(sum, ui) {
  if (!ui.opened) return h("p", { class: "muted" }, "点击“开始开袋”后展开验收清单。当前不会自动点数或领取。");
  const steps = [
    [true, "打开餐袋", "已打开，开始人工点数"],
    [sum.pendingKinds === 0, "逐项点数并确认数量", sum.pendingKinds ? `还有 ${sum.pendingKinds} 种未点数` : "全部已点数"],
    [sum.receiptComplete, "核对实收与应收", sum.receiptComplete ? "逐项一致" : sum.pendingKinds ? "等待点数完成" : `缺 ${sum.shortageTotal} 件，多 ${sum.overageTotal} 件`],
    [sum.totalPeople > 0 && sum.claimedPeople === sum.totalPeople, "逐人递出", sum.totalPeople ? `${sum.claimedPeople}/${sum.totalPeople} 人已领取` : "尚无领餐人，请先添加"],
  ];
  return h("ol", { class: `steps${ui.flash?.kind === "open" ? " reveal" : ""}` },
    steps.map(([done, title, note]) => h("li", { class: done ? "done" : "" },
      h("span", { class: "mark" }, done ? "完成" : "待办"), h("strong", {}, title), h("span", { class: "muted" }, note))));
}

export function foodRow(row, ui) {
  const [kind, label] = STATUS[row.status];
  const text = row.status === "short" ? `缺 ${row.shortage} 件` : row.status === "extra" ? `多 ${row.overage} 件` : label;
  const draft = ui.drafts[row.id] ?? row.received ?? "";
  return h("li", { class: `row${flashed(ui, "count", row.id) ? " flash" : ""}` },
    icon(row.category, "icon icon-lg"),
    h("div", { class: "row-name" }, h("strong", {}, row.name), h("span", { class: "muted" }, CATEGORY[row.category] ?? "其他"), pill(kind, text)),
    h("dl", { class: "nums" }, numCell("应收", row.expected), numCell("实收", row.received ?? "未点数"), numCell("已领", row.claimed), numCell("余量", row.remaining ?? "—")),
    h("form", { class: "qty", data: { form: "receive", id: row.id } },
      h("label", { for: `qty-${row.id}` }, "实收数量", h("span", { class: "sr" }, `（${row.name}）`)),
      h("input", { type: "number", id: `qty-${row.id}`, name: "qty", min: 0, max: 999, step: 1, inputmode: "numeric", value: draft, placeholder: "未点数", data: { draft: row.id, key: `qty:${row.id}` } }),
      button("确认数量", { type: "submit", variant: "primary", key: `confirm:${row.id}` }),
      button("清除点数", { action: "clear", id: row.id, disabled: row.received === null })));
}

export const rowsView = (sum, ui) => h("ul", { class: "rows" }, sum.rows.map((r) => foodRow(r, ui)));

export function personCard(person, state, sum, ui) {
  const claimed = state.claims[person.id];
  const wants = person.wants.map((w) => ({ row: sum.rows.find((r) => r.id === w.itemId), quantity: w.quantity }));
  const gaps = claimed ? [] : wants.flatMap(({ row, quantity }) =>
    row.received === null ? [`${row.name} 未点数`] : row.remaining < quantity ? [`${row.name} 差 ${quantity - row.remaining} 件`] : []);
  const reason = claimed ? "餐已递出，可退回重记。" : gaps.length
    ? `${gaps[0]}${gaps.length > 1 ? `等 ${gaps.length} 项待核对` : ""}`
    : "这份餐已备齐。";
  const why = `why-${person.id}`;
  return h("li", { class: `person${claimed ? " is-claimed" : ""}${flashed(ui, "hand", person.id) ? " handoff" : ""}` },
    h("div", { class: "person-head" }, h("strong", {}, person.name), pill(claimed ? "success" : "pending", claimed ? "已领取" : "待领取")),
    h("ul", { class: "wants" }, wants.map(({ row, quantity }) => h("li", {}, icon(row.category), `${row.name} × ${quantity}`))),
    h("p", { class: "muted", id: why }, reason),
    h("div", { class: "actions" },
      claimed ? button("退回这份餐", { action: "return", id: person.id, describedby: why }) :
        button("递给TA", { action: "claim", id: person.id, variant: "primary", disabled: gaps.length > 0, describedby: why })),
    flashed(ui, "hand", person.id) && h("span", { class: "stamp", "aria-hidden": "true" }, "已递出"));
}

export const peopleView = (state, sum, ui) => state.people.length
  ? h("ul", { class: "people" }, state.people.map((p) => personCard(p, state, sum, ui)))
  : h("p", { class: "muted" }, "尚无领餐人。请在下方“添加领餐人”逐人计划份数。");

export function addPersonForm(state, sum, ui) {
  const planned = (itemId) => state.people.reduce((n, p) => n + p.wants.filter((w) => w.itemId === itemId).reduce((a, w) => a + w.quantity, 0), 0);
  return h("details", { class: "add", open: ui.addOpen, data: { details: "add" } },
    h("summary", {}, "添加领餐人"),
    h("form", { class: "add-form", data: { form: "add-person" } },
      h("label", { for: "person-name" }, "姓名"),
      h("input", { id: "person-name", name: "name", maxlength: 80, required: true, autocomplete: "off", data: { key: "person-name" } }),
      h("fieldset", {}, h("legend", {}, "想要的餐品与份数"),
        sum.rows.map((r) => h("div", { class: "want" }, icon(r.category),
          h("label", { for: `want-${r.id}` }, `${r.name}（待计划 ${r.expected - planned(r.id)}）`),
          h("input", { type: "number", id: `want-${r.id}`, name: `want-${r.id}`, min: 0, max: 999, step: 1, inputmode: "numeric", value: 0 })))),
      button("加入名单", { type: "submit", variant: "primary" })));
}

export const orderInfo = (state) => h("details", { class: "info" },
  h("summary", {}, "订单来源与说明"),
  h("ul", {}, state.source === "synthetic"
    ? [h("li", {}, "合成团餐演示，人工虚构，不来自任何真实用户订单。"), h("li", {}, "数量全部由本页现场计算，未点数不等于 0。")]
    : [h("li", {}, "来自本地导入，已去掉地址、电话、订单号等字段，仅保留商品名与数量。"), h("li", {}, "原始 JSON 不保存；刷新页面后需重新导入。")]));

export const blankDecisions = (lines) => lines.map((l) => ({
  lineId: l.id,
  scope: l.children.length ? null : "per-package",
  children: (l.children.length ? l.children : [{ name: l.name, quantity: 1 }]).map((c) => ({ name: c.name, quantity: c.quantity, include: null, category: null })),
}));

const choice = (name, value, label, checked, data) =>
  h("label", { class: "choice" }, h("input", { type: "radio", name, value, checked, data: { ...data, key: `${name}:${value}` } }), h("span", {}, label));

export function importFields(imp) {
  return imp.inspection.lines.map((line, i) => {
    const d = imp.decisions[i];
    const single = line.children.length === 0;
    return h("fieldset", { class: "imp-line" },
      h("legend", {}, `${line.name}（数量 ${line.parentQuantity}）`),
      single ? h("p", { class: "muted" }, "单品：按商品数量计件。")
        : h("div", { class: "scope", role: "group", "aria-label": `${line.name} 数量口径` },
          choice(`scope-${i}`, "per-package", "每份套餐口径：子项数量 × 父数量", d.scope === "per-package", { imp: "scope", line: i }),
          choice(`scope-${i}`, "line-total", "整行合计口径：子项数量已是整行总数", d.scope === "line-total", { imp: "scope", line: i })),
      d.children.map((c, j) => h("div", { class: "imp-child" },
        h("strong", {}, c.name), !single && h("span", { class: "muted" }, `× ${c.quantity}`),
        h("div", { class: "inc", role: "group", "aria-label": `${c.name} 是否作为餐品` },
          choice(`inc-${i}-${j}`, "yes", "作为餐品", c.include === true, { imp: "include", line: i, child: j }),
          choice(`inc-${i}-${j}`, "no", "忽略为特调", c.include === false, { imp: "include", line: i, child: j })),
        h("label", { class: "cat" }, "类别",
          h("select", { disabled: c.include !== true, "aria-label": `${c.name} 类别`, data: { imp: "category", line: i, child: j, key: `cat-${i}-${j}` } },
            h("option", { value: "", selected: !c.category }, "选择类别"),
            Object.entries(CATEGORY).map(([v, t]) => h("option", { value: v, selected: c.category === v }, t)))))));
  });
}
