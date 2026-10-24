export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message); this.name = "ApiError"; this.code = code; this.status = status;
  }
}

export async function json(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ApiError("NETWORK", "连接中断或等待超时。请先刷新核对状态，不要重复提交订单。");
  }
  let value;
  try { value = await response.json(); }
  catch { throw new ApiError("RESPONSE", "服务返回了无法读取的内容，请刷新核对。", response.status); }
  if (!response.ok) throw new ApiError(
    typeof value.error?.code === "string" ? value.error.code : "REQUEST",
    typeof value.error?.message === "string" ? value.error.message : "本次操作没有完成。", response.status);
  return value;
}

export const money = (cents) => Number.isSafeInteger(cents) ? `¥${(cents / 100).toFixed(2)}` : "待核价";
export const groups = [
  ["all", "全部"], ["burger", "汉堡/主食"], ["snack", "小吃"],
  ["drink", "饮料"], ["dessert", "甜品"], ["other", "其他"],
];
export const phases = {
  collecting: "收集意愿", planning: "正在核价", planned: "选择买法", confirmed: "核对并确认",
  creating: "正在创建订单", "awaiting-payment": "待核对付款", "creation-unknown": "创建结果待核对",
  "creation-rejected": "创建未被接受", cancelled: "订单已取消", "paid-review": "已付款，餐品待核对", intaken: "已进入开袋台",
};
