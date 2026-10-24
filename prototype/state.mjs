export class DeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeskError";
    this.code = code;
  }
}

const categories = new Set(["burger", "fries", "drink", "other"]);
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (code, message) => { throw new DeskError(code, message); };
const count = (value, minimum = 0) =>
  Number.isInteger(value) && value >= minimum && value <= 999;
const label = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const identifier = (value) => typeof value === "string" && /^[a-zA-Z][\w-]{0,63}$/.test(value);

function parseWants(wants, items) {
  if (!Array.isArray(wants) || wants.length === 0 || wants.length > items.length) {
    fail("INVALID_WANTS", "请至少选择一种餐品及份数。");
  }
  const seen = new Set();
  return wants.map((want) => {
    if (!object(want) || !items.some((item) => item.id === want.itemId) ||
        !count(want.quantity, 1) || seen.has(want.itemId)) {
      fail("INVALID_WANTS", "领餐需求包含未知餐品、重复项目或无效份数。");
    }
    seen.add(want.itemId);
    return { itemId: want.itemId, quantity: want.quantity };
  });
}

function checkDemand(items, people) {
  for (const item of items) {
    const planned = people.reduce((sum, person) =>
      sum + (person.wants.find((want) => want.itemId === item.id)?.quantity ?? 0), 0);
    if (planned > item.expected) fail("DEMAND_EXCEEDS_ORDER", `${item.name}的分配份数超过应收数量。`);
  }
}

export function createDesk(order) {
  if (!object(order) || !label(order.title) || !["synthetic", "imported"].includes(order.source) ||
      !Array.isArray(order.items) || order.items.length === 0 || order.items.length > 100 ||
      !Array.isArray(order.people) || order.people.length > 50) {
    fail("INVALID_ORDER", "订单需要标题、1至100种餐品及最多50位领餐人。");
  }
  const ids = new Set();
  const items = order.items.map((item) => {
    if (!object(item) || !identifier(item.id) || ids.has(item.id) || !label(item.name) ||
        !categories.has(item.category) || !count(item.expected)) {
      fail("INVALID_ITEM", "餐品编号、名称、类别或应收数量无效。");
    }
    ids.add(item.id);
    return { id: item.id, name: item.name.trim(), category: item.category, expected: item.expected };
  });
  if (items.reduce((sum, item) => sum + item.expected, 0) > 10000) {
    fail("ORDER_TOO_LARGE", "单份清单最多支持10000件餐品。");
  }
  const personIds = new Set();
  const people = order.people.map((person) => {
    if (!object(person) || !identifier(person.id) || personIds.has(person.id) || !label(person.name)) {
      fail("INVALID_PERSON", "领餐人编号或姓名无效。");
    }
    personIds.add(person.id);
    return { id: person.id, name: person.name.trim(), wants: parseWants(person.wants, items) };
  });
  checkDemand(items, people);
  return {
    title: order.title.trim(), source: order.source, items, people,
    received: Object.fromEntries(items.map((item) => [item.id, null])),
    claims: Object.fromEntries(people.map((person) => [person.id, false])), history: [],
  };
}

export function summarize(state) {
  const rows = state.items.map((item) => {
    const received = state.received[item.id];
    const claimed = state.people.filter((person) => state.claims[person.id])
      .reduce((sum, person) =>
        sum + (person.wants.find((want) => want.itemId === item.id)?.quantity ?? 0), 0);
    const pending = received === null;
    return {
      ...item, received, claimed, remaining: pending ? null : received - claimed,
      shortage: pending ? null : Math.max(0, item.expected - received),
      overage: pending ? null : Math.max(0, received - item.expected),
      status: pending ? "pending" : received < item.expected ? "short" :
        received > item.expected ? "extra" : "matched",
    };
  });
  return {
    rows,
    expectedTotal: rows.reduce((sum, row) => sum + row.expected, 0),
    receivedTotal: rows.reduce((sum, row) => sum + (row.received ?? 0), 0),
    claimedTotal: rows.reduce((sum, row) => sum + row.claimed, 0),
    pendingKinds: rows.filter((row) => row.received === null).length,
    shortageTotal: rows.reduce((sum, row) => sum + (row.shortage ?? 0), 0),
    overageTotal: rows.reduce((sum, row) => sum + (row.overage ?? 0), 0),
    claimedPeople: state.people.filter((person) => state.claims[person.id]).length,
    totalPeople: state.people.length,
    receiptComplete: rows.every((row) => row.status === "matched"),
  };
}

export function restoreDesk(value) {
  const snapshot = (raw) => {
    const desk = createDesk(raw);
    if (!object(raw.received) || !object(raw.claims)) {
      fail("INVALID_SNAPSHOT", "开袋记录缺少点数或领取状态。");
    }
    for (const item of desk.items) {
      if (!Object.hasOwn(raw.received, item.id) ||
          (raw.received[item.id] !== null && !count(raw.received[item.id]))) {
        fail("INVALID_SNAPSHOT", "开袋记录中的实收数量无效。");
      }
      desk.received[item.id] = raw.received[item.id];
    }
    for (const person of desk.people) {
      if (typeof raw.claims[person.id] !== "boolean") fail("INVALID_SNAPSHOT", "领取状态无效。");
      desk.claims[person.id] = raw.claims[person.id];
    }
    if (summarize(desk).rows.some((row) => row.claimed > 0 &&
        (row.received === null || row.claimed > row.received))) {
      fail("INVALID_SNAPSHOT", "领取记录超过实收，未加载不一致数据。");
    }
    return desk;
  };
  const desk = snapshot(value);
  if (!Array.isArray(value.history) || value.history.length > 60) {
    fail("INVALID_SNAPSHOT", "撤销记录格式无效。");
  }
  desk.history = value.history.map((raw) => {
    const { history, ...previous } = snapshot(raw);
    return previous;
  });
  return desk;
}

export function reduceDesk(state, action) {
  if (!object(action)) fail("INVALID_ACTION", "操作格式无效。");
  if (action.type === "undo") {
    if (state.history.length === 0) fail("NOTHING_TO_UNDO", "还没有可以撤销的操作。");
    return { ...state.history.at(-1), history: state.history.slice(0, -1) };
  }
  const summary = summarize(state);
  let next;
  switch (action.type) {
    case "receiveMany": {
      if (!Array.isArray(action.counts) || action.counts.length === 0 ||
          action.counts.length > state.items.length) {
        fail("INVALID_QUANTITY", "批量点数需要对应清单中的餐品。");
      }
      const seen = new Set();
      let counted = state;
      for (const entry of action.counts) {
        if (!object(entry) || seen.has(entry.itemId)) {
          fail("INVALID_QUANTITY", "一次批量点数不能重复包含同一餐品。");
        }
        seen.add(entry.itemId);
        counted = reduceDesk(counted, { type: "receive", itemId: entry.itemId, quantity: entry.quantity });
      }
      if (counted === state) return state;
      next = { ...counted, history: state.history };
      break;
    }
    case "receive": {
      const row = summary.rows.find((item) => item.id === action.itemId);
      if (!row) fail("UNKNOWN_ITEM", "清单里没有这项餐品。");
      if (action.quantity !== null && !count(action.quantity)) {
        fail("INVALID_QUANTITY", "实收数量应为0至999的整数，未点数请明确恢复。");
      }
      if ((action.quantity === null && row.claimed > 0) ||
          (action.quantity !== null && action.quantity < row.claimed)) {
        fail("ALREADY_DISTRIBUTED", `已经发出${row.claimed}件，请先退回对应餐品再修正实收。`);
      }
      if (state.received[row.id] === action.quantity) return state;
      next = { ...state, received: { ...state.received, [row.id]: action.quantity } };
      break;
    }
    case "claim":
    case "return": {
      const person = state.people.find((item) => item.id === action.personId);
      if (!person) fail("UNKNOWN_PERSON", "领餐名单里没有这位。");
      const claiming = action.type === "claim";
      if (state.claims[person.id] === claiming) {
        fail(claiming ? "ALREADY_CLAIMED" : "NOT_CLAIMED",
          claiming ? "这份餐已经领过了。" : "这位还没有领餐。");
      }
      if (claiming) {
        for (const want of person.wants) {
          const row = summary.rows.find((item) => item.id === want.itemId);
          if (row.remaining === null) fail("UNCOUNTED", `${row.name}还没点数，请先确认实收。`);
          if (row.remaining < want.quantity) {
            fail("INSUFFICIENT_STOCK", `${row.name}还差${want.quantity - row.remaining}件，暂时不能递出这份餐。`);
          }
        }
      }
      next = { ...state, claims: { ...state.claims, [person.id]: claiming } };
      break;
    }
    case "addPerson": {
      if (!label(action.name) || state.people.length >= 50) {
        fail("INVALID_PERSON", "请输入1至80字的姓名，名单最多50人。");
      }
      const wants = parseWants(action.wants, state.items);
      let index = state.people.length + 1;
      while (state.people.some((person) => person.id === `person-${index}`)) index += 1;
      const person = { id: `person-${index}`, name: action.name.trim(), wants };
      const people = [...state.people, person];
      checkDemand(state.items, people);
      next = { ...state, people, claims: { ...state.claims, [person.id]: false } };
      break;
    }
    default: fail("INVALID_ACTION", "不支持这项操作。");
  }
  const { history, ...snapshot } = state;
  return { ...next, history: [...history, snapshot].slice(-60) };
}
