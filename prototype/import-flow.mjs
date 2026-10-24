import { createDesk } from "./state.mjs";
import { inspectOrder, resolveOrder } from "./order.mjs";
import { rawDemoOrder } from "./sample.mjs";
import { blankDecisions, importFields } from "./render.mjs";

export function setupImport({ getState, onImport }) {
  const q = (id) => document.getElementById(id);
  const dialog = q("import");
  let inspection = null;
  let version = 0;
  let armed = false;
  let opener = null;
  const disarm = () => {
    armed = false;
    q("import-replace").hidden = true;
    q("import-go").textContent = "生成应收清单";
    q("import-go").className = "btn btn-primary";
  };
  function paint() {
    const key = document.activeElement?.dataset?.key;
    q("import-lines").replaceChildren(...(inspection ? importFields(inspection) : []));
    const remaining = inspection?.decisions.reduce((sum, row) => sum + (row.scope ? 0 : 1) +
      row.children.filter((item) => typeof item.include !== "boolean" || (item.include && !item.category)).length, 0) ?? 0;
    q("import-go").disabled = !inspection || remaining > 0;
    q("import-hint").textContent = !inspection ? "先检查订单，再确认数量口径。" :
      remaining ? `还有 ${remaining} 项需要确认。` : "餐品与口径已确认。";
    if (key) dialog.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  function clearInspection() {
    version += 1;
    inspection = null;
    disarm();
    paint();
  }
  function check() {
    clearInspection();
    q("import-error").textContent = "";
    try {
      const text = q("raw").value;
      if (!text.trim()) throw new Error("请先粘贴或选择订单 JSON。");
      if (text.length > 1_000_000) throw new Error("内容超过1 MB，请精简后导入。");
      let raw;
      try { raw = JSON.parse(text); } catch { throw new Error("内容不是有效的 JSON。"); }
      const result = inspectOrder(raw);
      inspection = { inspection: result, decisions: blankDecisions(result.lines) };
    } catch (error) {
      q("import-error").textContent = error.message;
    }
    paint();
  }
  async function readFile(file) {
    if (!file) return;
    clearInspection();
    const requestVersion = version;
    if (file.size > 1_000_000) {
      q("import-error").textContent = "文件超过1 MB，请精简后导入。";
      return;
    }
    try {
      const text = await file.text();
      if (version !== requestVersion || !dialog.open) return;
      q("raw").value = text;
      q("import-error").textContent = "";
    } catch {
      if (version === requestVersion && dialog.open) {
        q("import-error").textContent = "无法读取这个文件，请重新选择。";
      }
    }
  }
  function confirm() {
    if (!inspection) return;
    let next;
    try { next = createDesk(resolveOrder(inspection.inspection, inspection.decisions)); }
    catch (error) { q("import-error").textContent = error.message; return; }
    const existing = getState();
    if ((existing.history.length || existing.source !== "synthetic") && !armed) {
      armed = true;
      q("import-replace").hidden = false;
      q("import-go").textContent = "替换当前清单";
      q("import-go").className = "btn btn-danger";
      q("import-replace").focus();
      return;
    }
    onImport(next);
    dialog.close();
  }
  dialog.addEventListener("input", (event) => {
    if (event.target.id === "raw") clearInspection();
  });
  dialog.addEventListener("change", (event) => {
    const field = event.target;
    if (field.id === "file") { void readFile(field.files[0]); return; }
    if (!inspection || !field.dataset.imp) return;
    disarm();
    const row = inspection.decisions[Number(field.dataset.line)];
    if (field.dataset.imp === "scope") row.scope = field.value;
    else if (field.dataset.imp === "include") row.children[Number(field.dataset.child)].include = field.value === "yes";
    else row.children[Number(field.dataset.child)].category = field.value || null;
    paint();
  });
  dialog.addEventListener("close", () => {
    clearInspection();
    q("raw").value = "";
    q("file").value = "";
    q("import-error").textContent = "";
    opener?.focus?.();
  });
  return {
    "import-open": () => { opener = document.activeElement; paint(); dialog.showModal(); },
    "import-sample": () => { q("raw").value = JSON.stringify(rawDemoOrder, null, 2); clearInspection(); },
    "import-check": check,
    "import-confirm": confirm,
  };
}
