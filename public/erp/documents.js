import { button, field, table, openEditor } from "./ui.js";
const names = { invoice: "商业发票", packing_list: "装箱单", purchase_order: "采购单" };
export function mountDocuments(container, { row, type, api, mutation, current }) {
  const section = document.createElement("section"); section.id = "issued-documents"; section.hidden = true;
  const list = document.createElement("div"); list.className = "table-scroll";
  const preview = document.createElement("div"); preview.className = "document-preview";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  section.append(status, list, preview); container.append(section);
  let generation = 0, disposed = false;
  const valid = n => !disposed && current() && section.isConnected && n === generation;
  function clear() { generation++; preview.replaceChildren(); status.textContent = ""; }
  async function exported(id, history = false) {
    return api(`/documents/${id}/export${history ? "?history=1" : ""}`);
  }
  async function display(id, history = false) {
    clear(); section.hidden = false; const n = generation;
    try {
      const data = await exported(id, history);
      if (!valid(n)) return;
      status.textContent = data.historical ? "历史快照：已过期或待重审，不可作为当前有效单证。" : "不可变业务快照。使用前核对当前有效性，不代表海关认证或已盖章。";
      const toolbar = document.createElement("div"); toolbar.className = "actions";
      const iframe = document.createElement("iframe"); iframe.title = "单证预览";
      iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
      iframe.srcdoc = data.html;
      const fresh = async () => {
        preview.replaceChildren(); const result = await exported(id, history);
        if (!valid(n)) return null;
        preview.append(toolbar, iframe);
        return result;
      };
      toolbar.append(button(data.historical ? "下载历史 HTML" : "下载 HTML", async () => {
        const result = await fresh(); if (!result) return;
        const url = URL.createObjectURL(new Blob([result.html], { type: "text/html;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = result.filename;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }), button("打印 / PDF", async () => {
        const result = await fresh(); if (!result) return;
        await new Promise(resolve => {
          iframe.onload = resolve;
          iframe.srcdoc = result.html;
        });
        if (valid(n)) { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      }));
      preview.append(toolbar, iframe);
    } catch (error) {
      if (!valid(n)) return;
      status.textContent = error.code === "DOCUMENT_STALE" ? "来源已变更，仅可导出历史版本。请重新审核当前业务。" : `单证读取失败：${error.message}`;
      if (error.code === "DOCUMENT_STALE") preview.append(button("明确查看历史快照", () => display(id, true)));
    }
  }
  async function load() {
    clear(); list.replaceChildren(); section.hidden = false; const n = generation;
    try {
      const data = await api(`/documents?document_id=${row.id}`);
      if (!valid(n)) return;
      list.append(table([
        { key: "number", label: "单证号" }, { label: "类型", value: d => names[d.kind] },
        { label: "源版本", value: d => `v${d.document_version}` },
        { label: "状态", value: d => d.stale ? "已过期 / 待重审" : "可用快照" },
      ], data.items, d => display(d.id)));
    } catch (error) { if (valid(n)) status.textContent = `档案读取失败：${error.message}`; }
  }
  async function issue() {
    const n = generation;
    const purchase = type === "purchases";
    const events = purchase ? [] : (await api(`/${type}/${row.id}/fulfilments`)).items.filter(e => e.kind === "ship");
    if (!valid(n)) return;
    const batches = [...new Map(events.map(e => [e.id, { value: e.id, label: `${new Date(e.created_at).toLocaleString("zh-CN")} · ${e.id.slice(0, 8)}` }])).values()];
    if (!purchase && !batches.length) throw new Error("请先完成实际出库；不能按未发货订单生成商业发票");
    const key = crypto.randomUUID();
    openEditor("生成不可变单证", field("kind", "模板", purchase ? "purchase_order" : "invoice", {
      options: (purchase ? ["purchase_order"] : ["invoice", "packing_list"]).map(value => ({ value, label: names[value] })),
    }) + (purchase ? "" : field("fulfilment_id", "出库批次", "", { options: batches }))
      + field("language", "单证语言", "zh", { options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }, { value: "ru", label: "Русский" }] })
      + field("issue_date", "签发日期", new Date().toISOString().slice(0, 10), { type: "date" })
      + (purchase ? "" : '<div class="full summary-note">装箱单必须填写件数、重量和唛头；商业发票不使用这些字段。单位为千克，不自动估算。</div>'
        + field("packages", "件数", "", { required: false }) + field("gross_kg", "毛重 kg", "", { required: false })
        + field("net_kg", "净重 kg", "", { required: false }) + field("marks", "唛头", "", { required: false }))
      + field("confirmed", "资料确认", "", { options: [{ value: "", label: "请选择" }, { value: "yes", label: "已核对企业、客户地址、条款和批次资料" }] })
      + '<p class="full summary-note">企业名称/地址来自企业资料，往来方地址来自档案；源数据不足将阻断生成。文件不含默认东大印章，不替代正式海关单证。</p>',
    async values => {
      if (!valid(n)) throw new Error("当前记录已切换，请重新打开制单");
      const data = await mutation("/documents", "POST", { document_id: row.id, version: row.version, kind: values.kind,
        language: values.language, issue_date: values.issue_date, fulfilment_id: values.fulfilment_id || null,
        confirmed: values.confirmed === "yes", packing: { packages: values.packages, gross_kg: values.gross_kg, net_kg: values.net_kg, marks: values.marks } }, key);
      if (!valid(n)) return;
      await load(); await display(data.id);
    });
  }
  const hide = () => { if (document.hidden) clear(); };
  document.addEventListener("visibilitychange", hide);
  return { load, issue, dispose() { disposed = true; clear(); section.replaceChildren(); document.removeEventListener("visibilitychange", hide); } };
}
