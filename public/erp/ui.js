export const $ = selector => document.querySelector(selector);
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const states = { draft: "草稿", review: "待审核", approved: "已批准", confirmed: "已确认", scheduled: "已排期", published: "已发布",
  partial: "部分履约", fulfilled: "已履约", completed: "已完成", cancelled: "已取消", sent: "已发送", accepted: "已接受",
  new: "新询盘", qualified: "有效询盘", lost: "已关闭", won: "已成交", in_transit: "在途", posted: "已过账" };
export const badge = state => `<span class="state ${esc(state)}">${esc(states[state] || state)}</span>`;
export const qty = v => v == null ? "" : String(v).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
export const date = v => v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "未设置";
export const button = (name, run, cls = "") => {
  const el = document.createElement("button"); el.textContent = name; el.className = cls; el.type = "button";
  el.addEventListener("click", async () => { el.disabled = true; try { await run(); } catch (e) { notice(e.message, true); } finally { el.disabled = false; } });
  return el;
};
export function notice(message = "", error = false) { $("#notice").textContent = message; $("#notice").className = error ? "error" : ""; }
export function table(columns, items, onSelect) {
  const el = document.createElement("table");
  el.innerHTML = `<thead><tr>${columns.map(c => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${items.length ? items.map((row, i) => `<tr>${columns.map((c, j) => `<td class="${c.num ? "num" : ""}">${j === 0 && onSelect
      ? `<button class="link" data-row="${i}">${esc(c.value ? c.value(row) : row[c.key])}</button>`
      : c.html ? c.html(row) : esc(c.value ? c.value(row) : row[c.key])}</td>`).join("")}</tr>`).join("")
      : `<tr><td class="empty" colspan="${columns.length}">暂无记录。录入业务后，数据将在这里显示。</td></tr>`}</tbody>`;
  el.querySelectorAll("[data-row]").forEach(b => b.addEventListener("click", () => Promise.resolve(onSelect(items[Number(b.dataset.row)])).catch(e => notice(e.message, true))));
  return el;
}
export function field(name, label, value = "", { type = "text", options, required = true, full = false, readonly = false } = {}) {
  const id = `field-${name}`, attrs = `${required ? "required" : ""} ${readonly ? "readonly" : ""}`;
  const input = options ? `<select id="${esc(id)}" name="${esc(name)}" ${attrs}>${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
    : type === "textarea" ? `<textarea id="${esc(id)}" name="${esc(name)}" ${attrs}>${esc(value)}</textarea>`
    : `<input id="${esc(id)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${attrs}>`;
  return `<div class="${full ? "full" : ""}"><label for="${esc(id)}">${esc(label)}</label>${input}</div>`;
}
let onSave = null, saving = false, previousFocus;
export function openEditor(title, html, save) {
  previousFocus = document.activeElement;
  $("#editor-title").textContent = title; $("#editor-fields").innerHTML = html;
  $("#editor-error").textContent = ""; onSave = save;
  $("#editor").showModal();
}
export function closeEditor() { if (saving) return; $("#editor").close(); $("#editor-fields").replaceChildren(); onSave = null; previousFocus?.focus(); }
$("#close-editor").addEventListener("click", closeEditor);
$("#editor").addEventListener("cancel", e => { e.preventDefault(); closeEditor(); });
$("#editor-form").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#editor-form").requestSubmit(); }
});
$("#editor-form").addEventListener("submit", async e => {
  e.preventDefault(); if (saving || !onSave) return;
  saving = true; const submit = $("#editor-form button[type=submit]"); submit.disabled = true;
  try {
    await onSave(Object.fromEntries(new FormData(e.currentTarget)));
    saving = false; closeEditor();
  } catch (error) { $("#editor-error").textContent = error.message; }
  finally { saving = false; submit.disabled = false; }
});
