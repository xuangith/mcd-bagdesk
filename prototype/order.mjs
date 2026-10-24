export class OrderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new OrderError(code, message); };
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nameValid = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const quantityValid = (value) => Number.isInteger(value) && value > 0 && value <= 999;
const categories = new Set(["burger", "fries", "drink", "other"]);

export function inspectOrder(raw) {
  if (!object(raw) || raw.success === false ||
      (raw.code !== undefined && raw.code !== 200)) {
    fail("INVALID_ORDER", "这不是成功返回的订单数据。");
  }
  const body = object(raw.data) ? raw.data : raw;
  if (!Array.isArray(body.orderProductList) || body.orderProductList.length === 0 ||
      body.orderProductList.length > 100) {
    fail("INVALID_PRODUCTS", "需要含1至100行商品的 orderProductList。");
  }
  const lines = body.orderProductList.map((product, index) => {
    if (!object(product) || !nameValid(product.productName) || !quantityValid(product.quantity)) {
      fail("INVALID_PRODUCT", `第${index + 1}行的商品名称或数量无效。`);
    }
    const children = product.comboItemList ?? [];
    if (!Array.isArray(children) || children.length > 100) {
      fail("INVALID_CHILDREN", `第${index + 1}行的套餐子项格式无效。`);
    }
    return {
      id: `line-${index + 1}`, name: product.productName.trim(),
      parentQuantity: product.quantity,
      children: children.map((item) => {
        if (!object(item) || !nameValid(item.itemName) || !quantityValid(item.itemQuantity)) {
          fail("INVALID_CHILD", "套餐子项需要有效名称和正整数数量，未知项不能自动按0计算。");
        }
        return { name: item.itemName.trim(), quantity: item.itemQuantity };
      }),
    };
  });
  return { lines };
}

export function resolveOrder(inspection, decisions) {
  if (!object(inspection) || !Array.isArray(inspection.lines) ||
      !Array.isArray(decisions) || decisions.length !== inspection.lines.length) {
    fail("MISSING_DECISIONS", "请逐行确认订单的数量口径和全部子项。");
  }
  const items = [];
  const names = new Map();
  const seen = new Set();
  for (const line of inspection.lines) {
    const decision = decisions.find((item) => object(item) && item.lineId === line.id);
    if (!decision || seen.has(decision.lineId) ||
        !["per-package", "line-total"].includes(decision.scope)) {
      fail("MISSING_SCOPE", `请为“${line.name}”选择每份套餐或整行合计口径。`);
    }
    seen.add(decision.lineId);
    const children = line.children.length ? line.children : [{ name: line.name, quantity: 1 }];
    if (!Array.isArray(decision.children) || decision.children.length !== children.length ||
        (line.children.length === 0 && decision.scope !== "per-package")) {
      fail("MISSING_CHILD_DECISIONS", `请完整确认“${line.name}”的子项。`);
    }
    children.forEach((child, index) => {
      const chosen = decision.children[index];
      if (!object(chosen) || chosen.name !== child.name || chosen.quantity !== child.quantity ||
          typeof chosen.include !== "boolean") {
        fail("UNCONFIRMED_CHILD", `请确认“${child.name}”作为餐品，还是忽略为特调。`);
      }
      if (!chosen.include) return;
      if (!categories.has(chosen.category)) fail("MISSING_CATEGORY", "请选择已确认餐品的类别。");
      const quantity = child.quantity * (decision.scope === "per-package" ? line.parentQuantity : 1);
      const key = child.name;
      if (names.has(key)) {
        const item = items[names.get(key)];
        if (item.category !== chosen.category) {
          fail("CATEGORY_CONFLICT", `“${child.name}”被分成了不同类别，请统一确认。`);
        }
        item.expected += quantity;
        if (item.expected > 999) fail("TOO_MANY_ITEMS", "每种餐品最多999件。");
      } else {
        if (quantity > 999) fail("TOO_MANY_ITEMS", "每种餐品最多999件。");
        names.set(key, items.length);
        items.push({
          id: `food-${items.length + 1}`, name: child.name,
          category: chosen.category, expected: quantity,
        });
      }
    });
  }
  if (items.length === 0 || items.length > 100 ||
      items.reduce((sum, item) => sum + item.expected, 0) > 10000) {
    fail("INVALID_TOTAL", "请确认至少一种餐品，最多100种、10000件。");
  }
  return { title: "本地订单 · 已人工确认口径", source: "imported", items, people: [] };
}
