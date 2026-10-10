import { $, esc, badge, qty, date, button, notice, table, field, openEditor, closeEditor } from "./ui.js";
import { mountWebsiteSource } from "./website-source.js";
import { mountDocuments } from "./documents.js";
import { mountMember, memberRoles } from "./members.js";

const groups = [
  ["社媒与获客", [["contents", "内容运营"], ["social-accounts", "社媒账号"], ["leads", "询盘跟进"], ["quotes", "客户报价"]]],
  ["交易与履约", [["orders", "销售订单"], ["purchases", "采购订单"], ["inventory", "库存余额"], ["movements", "库存流水"], ["transfers", "仓库调拨"], ["stocktakes", "盘点调整"]]],
  ["财务协同", [["finance", "东大财务接入"]]],
  ["基础资料", [["partners", "客户与供应商"], ["products", "商品资料"], ["warehouses", "仓库设置"], ["settings", "企业资料"], ["members", "企业成员"], ["audit", "操作审计"]]],
];
const titles = Object.fromEntries(groups.flatMap(([, items]) => items));
const roles = memberRoles;
const platforms = { facebook: "Facebook", instagram: "Instagram", whatsapp: "WhatsApp", tiktok: "TikTok", telegram: "Telegram", wechat: "微信", douyin: "抖音", linkedin: "LinkedIn", other: "其他" };
const warehouseKinds = { domestic: "国内仓", bonded: "保税仓", overseas: "海外仓", fba: "FBA 仓", transit: "在途仓" };
const partnerKinds = { customer: "客户", supplier: "供应商", both: "客户及供应商" };
const options = object => Object.entries(object).map(([value, label]) => ({ value, label }));
const currencies = options(Object.fromEntries(["USD", "EUR", "CNY", "KZT", "UZS", "RUB", "GBP", "AED", "JPY", "KWD"].map(v => [v, v])));
let identity = null, epoch = 0, view = "orders", page = 1, search = "", selected = null;
let detailSequence = 0, sourceView = null, documentsView = null;
const draftKeys = new Map();

async function api(path, method = "GET", body, key) {
  const generation = epoch;
  const response = await fetch(`/api/v1${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-ERP-Request": "1", ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (generation !== epoch) throw new Error("身份已改变，请重新操作");
  if (!response.ok) {
    if (response.status === 401 && identity) clearSession();
    throw Object.assign(new Error(`${data.error?.message || "请求失败"}${data.requestId ? ` · 请求 ${data.requestId.slice(0, 8)}` : ""}`),
      { status: response.status, code: data.error?.code });
  }
  return data;
}
async function mutation(path, method, body, key) {
  if (key) return api(path, method, body, key);
  const signature = JSON.stringify([epoch, path, method, body]);
  if (!draftKeys.has(signature)) draftKeys.set(signature, crypto.randomUUID());
  // Retain the command identity until its receipt is known, including lost-response retries.
  const result = await api(path, method, body, draftKeys.get(signature));
  draftKeys.delete(signature);
  return result;
}
function can(...allowed) { return identity?.role === "admin" || allowed.includes(identity?.role); }
function clearDetail() {
  detailSequence++; selected = null;
  sourceView?.dispose(); sourceView = null;
  documentsView?.dispose(); documentsView = null;
  $("#detail").hidden = true; $("#detail").replaceChildren();
}
function clearSession() {
  epoch++; identity = null; selected = null; draftKeys.clear();
  clearDetail();
  $("#workspace").hidden = true; $("#login-screen").hidden = false;
  $("#detail").replaceChildren(); $("#table-region").replaceChildren(); $("#editor").close(); $("#editor-fields").replaceChildren();
  $("#login-form").reset(); $("#login-error").textContent = ""; notice();
}
async function enter(data) {
  identity = data;
  $("#login-screen").hidden = true; $("#workspace").hidden = false;
  $("#tenant-name").textContent = data.tenant.name; $("#user-name").textContent = `${data.user.name} · ${roles[data.role]}`;
  $("#login-form").reset();
  const nav = $("#navigation"); nav.replaceChildren();
  for (const [label, items] of groups) {
    const h = document.createElement("div"); h.className = "group-title"; h.textContent = label; nav.append(h);
    for (const [key, name] of items) {
      if (key === "members" && !can()) continue;
      if (["audit", "finance"].includes(key) && !can("auditor")) continue;
      const b = button(name, () => navigate(key)); b.dataset.nav = key; nav.append(b);
    }
  }
  await navigate("orders");
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault(); const b = e.currentTarget.querySelector("button"); b.disabled = true;
  try { await enter(await api("/auth/login", "POST", Object.fromEntries(new FormData(e.currentTarget)))); }
  catch (error) { $("#login-error").textContent = error.message; }
  finally { b.disabled = false; }
});
$("#logout").addEventListener("click", async () => {
  try { await api("/auth/logout", "POST", {}); clearSession(); } catch (e) { notice(e.message, true); }
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); search = $("#search").value; page = 1; refresh().catch(e => notice(e.message, true)); });
async function navigate(key) {
  clearDetail();
  view = key; page = 1; search = ""; selected = null; $("#search").value = "";
  $("#workspace").dataset.view = key; $("#view-title").textContent = titles[key];
  $("#section-label").textContent = groups.find(([, items]) => items.some(([v]) => v === key))[0];
  document.querySelectorAll("[data-nav]").forEach(b => b.setAttribute("aria-current", b.dataset.nav === key ? "page" : "false"));
  $("#detail").hidden = true; $("#detail").replaceChildren(); notice();
  await refresh();
}
const column = (key, label, extra = {}) => ({ key, label, ...extra });
const statusColumn = column("state", "状态", { html: row => badge(row.state) });
const dateColumn = column("created_at", "创建时间", { value: row => date(row.created_at) });
const columns = {
  members: [column("name", "成员姓名"), column("email", "邮箱"), column("role", "本企业角色", { value: x => roles[x.role] }),
    column("active", "本企业状态", { value: x => x.active ? "启用" : "停用" }),
    column("account_active", "全局账号", { value: x => x.account_active ? "有效" : "已停用" }), column("version", "权限版本")],
  partners: [column("name", "名称"), column("kind", "业务身份", { value: x => partnerKinds[x.kind] }), column("contact", "联系方式"), column("email", "邮箱"), column("active", "启用", { value: x => x.active ? "启用" : "停用" })],
  products: [column("name", "商品名称"), column("code", "SKU"), column("unit", "单位"), column("price", "参考单价", { num: true, value: x => qty(x.price) }), column("currency", "币种"), column("active", "状态", { value: x => x.active ? "启用" : "停用" })],
  warehouses: [column("name", "仓库名称"), column("code", "编码"), column("kind", "类型", { value: x => warehouseKinds[x.kind] })],
  "social-accounts": [column("name", "账号名称"), column("platform", "平台", { value: x => platforms[x.platform] }), column("handle", "账号标识"), column("connection_state", "接口连接", { value: () => "未接通 · 人工管理" })],
  contents: [column("title", "内容标题"), statusColumn, column("language", "语言"), column("scheduled_at", "排期", { value: x => date(x.scheduled_at) }), column("publication_source", "发布来源", { value: x => x.publication_source === "manual" ? "人工登记" : "未发布" })],
  leads: [column("name", "姓名或企业"), statusColumn, column("contact", "联系方式"), column("need", "需求"), column("next_followup_at", "下次跟进", { value: x => date(x.next_followup_at) })],
  inventory: [column("product_name", "商品"), column("product_code", "SKU"), column("warehouse_name", "仓库"), ...["on_hand", "reserved", "frozen", "available"].map((k, i) => column(k, ["在库", "占用", "待检", "可用"][i], { num: true, value: x => qty(x[k]) }))],
  movements: [column("product_name", "商品"), column("warehouse_name", "仓库"), column("kind", "动作"), ...["delta_on_hand", "delta_reserved", "delta_frozen"].map((k, i) => column(k, ["在库变动", "占用变动", "待检变动"][i], { num: true, value: x => qty(x[k]) })), dateColumn],
  transfers: [column("id", "调拨编号", { value: x => x.id.slice(0, 8) }), statusColumn, column("quantity", "计划量", { num: true, value: x => qty(x.quantity) }), column("in_transit", "在途", { num: true, value: x => qty(x.in_transit) }), column("received", "已到货", { num: true, value: x => qty(x.received) }), dateColumn],
  stocktakes: [column("id", "盘点编号", { value: x => x.id.slice(0, 8) }), statusColumn, column("reason", "盘点原因"), dateColumn],
  audit: [column("action", "操作"), column("resource_type", "资源类型"), column("resource_id", "记录编号"), column("request_id", "请求编号"), dateColumn],
};
for (const type of ["quotes", "orders", "purchases"]) columns[type] = [
  column("number", "单据编号"), column("partner_name", type === "purchases" ? "供应商" : "客户"), statusColumn,
  column("total", "金额", { num: true }), column("currency", "币种"), column("due_date", "交期", { value: x => x.due_date?.slice(0, 10) || "未设置" }), dateColumn,
];
const editable = key => ({ partners: can("sales", "social", "purchasing"), products: can("purchasing"), warehouses: can(),
  "social-accounts": can("social"), contents: can("social"), leads: can("sales", "social"), quotes: can("sales"),
  orders: can("sales"), purchases: can("purchasing"), transfers: can("warehouse"), stocktakes: can("warehouse") })[key];

async function refresh() {
  clearDetail();
  const currentView = view, generation = epoch;
  const tools = $("#tools"); tools.replaceChildren();
  if (editable(view)) tools.append(button("新建", () => editRecord(view), "primary"));
  if (view === "inventory") {
    if (can("warehouse")) tools.append(button("期初入库", opening));
    if (can("warehouse", "auditor")) tools.append(button("流水核对", async () => {
      const result = await api("/inventory/reconcile"); notice(result.consistent ? "库存余额与不可变流水一致" : `发现 ${result.differences.length} 项差异`, !result.consistent);
    }));
  }
  tools.append(button("刷新", refresh));
  if (view === "settings") return settings();
  if (view === "finance") return finance();
  const path = view === "inventory" ? "/inventory/balances" : view === "movements" ? "/inventory/movements" : `/${view}`;
  const result = await api(`${path}?page=${page}&search=${encodeURIComponent(search)}`);
  if (currentView !== view || generation !== epoch) return;
  const selectable = !["inventory", "movements", "audit"].includes(view);
  $("#table-region").replaceChildren(table(columns[view], result.items, selectable ? row => detail(currentView, row.id) : null));
  const pagination = $("#pagination"); pagination.replaceChildren();
  const label = document.createElement("span"); label.textContent = result.total == null ? `显示 ${result.items.length} 条` : `共 ${result.total} 条 · 第 ${page} 页`;
  pagination.append(label);
  if (result.total != null) {
    const prev = button("上一页", async () => { page--; await refresh(); }); prev.disabled = page <= 1;
    const next = button("下一页", async () => { page++; await refresh(); }); next.disabled = page * (result.pageSize || 30) >= result.total;
    pagination.append(prev, next);
  }
}
async function all(path) {
  let result = [], p = 1;
  while (true) {
    const data = await api(`/${path}?page=${p}&pageSize=100`); result.push(...data.items);
    if (data.total == null || result.length >= data.total) return result;
    if (++p > 100) throw new Error("资料量较大，请先筛选后操作");
  }
}
const selectOptions = (rows, blank = false) => [...(blank ? [{ value: "", label: "不关联" }] : []), ...rows.filter(x => x.active !== false).map(x => ({ value: x.id, label: x.name || x.title || x.number }))];
function editor(title, fields, submit) {
  const key = crypto.randomUUID();
  openEditor(title, fields, async values => {
    const row = await submit(values, key);
    await refresh();
    if (row?.id) await detail(view, row.id);
    notice("已保存到服务端");
  });
}
async function editRecord(type, row = {}) {
  const optional = { required: false };
  let html = "", shape = values => values;
  if (type === "partners") {
    html = field("name", "名称", row.name) + field("kind", "业务身份", row.kind || "customer", { options: options(partnerKinds) })
      + field("contact", "联系方式", row.contact, optional) + field("email", "邮箱", row.email, { ...optional, type: "email" })
      + field("country", "国家", row.country, optional) + field("address", "地址", row.address, optional);
  } else if (type === "products") {
    html = field("code", "SKU 编码", row.code) + field("name", "名称", row.name) + field("unit", "基础单位", row.unit || "pcs")
      + field("price", "参考单价", qty(row.price) || "0") + field("currency", "币种", row.currency || "USD", { options: currencies })
      + field("spec", "规格", row.spec, optional) + field("hs_code", "HS 编码", row.hs_code, optional);
  } else if (type === "warehouses") {
    html = field("code", "仓库编码", row.code) + field("name", "名称", row.name)
      + field("kind", "仓库类型", row.kind || "domestic", { options: options(warehouseKinds) });
  } else if (type === "social-accounts") {
    html = field("name", "名称", row.name) + field("platform", "平台", row.platform || "facebook", { options: options(platforms) })
      + field("handle", "账号标识", row.handle, optional)
      + '<p class="full summary-note">这里只登记账号资料。自动发布与收信尚需官方授权，不会以人工记录替代接口回执。</p>';
  } else if (type === "contents") {
    const accounts = await all("social-accounts");
    if (!accounts.length) throw new Error("请先建立社媒账号资料");
    html = field("title", "标题", row.title) + field("account_id", "社媒账号", row.account_id, { options: selectOptions(accounts) })
      + field("language", "语言", row.language || "zh", { options: options({ zh: "中文", en: "英文", ru: "俄文", kk: "哈萨克文", uz: "乌兹别克文", other: "其他" }) })
      + field("body", "正文", row.body, { type: "textarea", full: true });
  } else if (type === "leads") {
    const [accounts, partners, contents] = await Promise.all([all("social-accounts"), all("partners"), all("contents")]);
    html = field("name", "姓名或企业", row.name) + field("contact", "联系方式", row.contact, optional)
      + field("account_id", "社媒账号", row.account_id, { options: selectOptions(accounts, true), ...optional })
      + field("content_id", "来源内容", row.content_id, { options: selectOptions(contents, true), ...optional })
      + field("partner_id", "业务客户", row.partner_id, { options: selectOptions(partners.filter(p => p.kind !== "supplier"), true), ...optional })
      + field("need", "需求", row.need, { type: "textarea", full: true, ...optional });
  } else if (["orders", "quotes", "purchases"].includes(type)) return editTrade(type, row);
  else if (type === "transfers" || type === "stocktakes") return editWarehouse(type);
  else throw new Error("此模块暂无可用编辑操作");
  editor(row.id ? "编辑记录" : `新建${titles[type]}`, html, async (values, key) =>
    mutation(`/${type}${row.id ? `/${row.id}` : ""}`, row.id ? "PATCH" : "POST", { ...shape(values), ...(row.id ? { version: row.version } : {}) }, key));
}
async function editTrade(type, row = {}, leadId) {
  const [partners, warehouses, products] = await Promise.all([all("partners"), all("warehouses"), all("products")]);
  const eligible = partners.filter(p => p.kind === "both" || p.kind === (type === "purchases" ? "supplier" : "customer"));
  if (!eligible.length || !warehouses.length || !products.length) throw new Error("请先录入客户/供应商、商品与仓库资料");
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const html = field("partner_id", type === "purchases" ? "供应商" : "客户", row.partner_id, { options: selectOptions(eligible) })
    + field("warehouse_id", "仓库", row.warehouse_id, { options: selectOptions(warehouses) })
    + field("currency", "币种", row.currency || "USD", { options: currencies })
    + field("due_date", "交期", row.due_date || "", { type: "date", required: false })
    + (type === "quotes" ? field("valid_until", "报价有效期", row.valid_until || nextMonth, { type: "date" }) : "")
    + field("terms", "贸易条款", row.terms || "", { required: false })
    + field("note", "备注", row.note || "", { required: false })
    + (leadId ? '<p class="full summary-note">请明确选择内部商品、正式数量与单价。官网商品标识、样品数量和预计采购量不会自动带入。</p>' : "")
    + '<div class="full"><h3>商品明细</h3><div id="line-editor"></div><div id="line-tools"></div></div>';
  editor(row.id ? `修改 ${row.number}` : `新建${titles[type]}`, html, async (values, key) => {
    const lines = [...document.querySelectorAll("#line-editor .line-grid")].map(el => ({
      ...(el.dataset.id ? { id: el.dataset.id } : {}),
      product_id: el.querySelector('[data-field="product"]').value,
      quantity: el.querySelector('[data-field="quantity"]').value,
      price: el.querySelector('[data-field="price"]').value,
    }));
    return mutation(`/${type}${row.id ? `/${row.id}` : ""}`, row.id ? "PATCH" : "POST",
      { ...values, lines, ...(row.id ? { version: row.version } : {}), ...(leadId ? { lead_id: leadId } : {}) }, key);
  });
  let lineIndex = 0;
  function addLine(line = {}) {
    const index = lineIndex++, el = document.createElement("div"); el.className = "line-grid"; if (line.id) el.dataset.id = line.id;
    const explicit = Boolean(leadId && !row.id);
    el.innerHTML = field(`product-${index}`, "商品", line.product_id || "", { options: [...(explicit ? [{ value: "", label: "请选择内部商品" }] : []), ...selectOptions(products)] })
      + field(`quantity-${index}`, "数量", qty(line.quantity) || (explicit ? "" : "1"))
      + field(`price-${index}`, "单价", qty(line.price) || (explicit ? "" : qty(products[0].price)));
    el.querySelector("select").dataset.field = "product";
    const inputs = el.querySelectorAll("input"); inputs[0].dataset.field = "quantity"; inputs[1].dataset.field = "price";
    el.querySelector("select").addEventListener("change", e => { inputs[1].value = qty(products.find(p => p.id === e.target.value)?.price); });
    el.append(button("移除", () => {
      if ($("#line-editor").children.length === 1) throw new Error("单据至少保留一行");
      el.remove();
    }));
    $("#line-editor").append(el);
  }
  (row.lines || [{}]).forEach(addLine); $("#line-tools").append(button("添加明细", () => addLine()));
}
async function opening() {
  const [warehouses, products] = await Promise.all([all("warehouses"), all("products")]);
  if (!warehouses.length || !products.length) throw new Error("请先创建商品及仓库");
  editor("期初入库", field("warehouse_id", "仓库", "", { options: selectOptions(warehouses) })
    + field("product_id", "商品", "", { options: selectOptions(products) }) + field("quantity", "数量", "1")
    + '<p class="full summary-note">仅适用于该仓库商品尚无流水时的期初开账。后续差异使用盘点，不重复补录期初。</p>',
  (values, key) => mutation("/inventory/opening", "POST", values, key).then(() => null));
}
async function editWarehouse(type) {
  const [warehouses, products] = await Promise.all([all("warehouses"), all("products")]);
  if (!warehouses.length || !products.length) throw new Error("请先创建商品及仓库");
  const html = type === "transfers" ? field("source_warehouse_id", "调出仓库", "", { options: selectOptions(warehouses) })
    + field("target_warehouse_id", "调入仓库", "", { options: selectOptions(warehouses) })
    + field("product_id", "商品", "", { options: selectOptions(products) }) + field("quantity", "数量", "1")
    : field("warehouse_id", "仓库", "", { options: selectOptions(warehouses) })
      + field("product_id", "商品", "", { options: selectOptions(products) }) + field("counted", "实盘数量", "0")
      + field("reason", "盘点原因", "");
  editor(`新建${titles[type]}`, html, (values, key) => mutation(`/${type}`, "POST",
    type === "transfers" ? values : { warehouse_id: values.warehouse_id, reason: values.reason, lines: [{ product_id: values.product_id, counted: values.counted }] }, key));
}
function facts(items) {
  return `<dl class="facts">${items.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${esc(v ?? "")}</dd></div>`).join("")}</dl>`;
}
async function detail(type, id) {
  clearDetail();
  const sequence = detailSequence;
  const row = await api(`/${type}/${id}`);
  if (view !== type || sequence !== detailSequence) return;
  selected = row;
  const panel = $("#detail"); panel.hidden = false;
  panel.innerHTML = `<div class="detail-heading"><h2>${esc(row.number || row.title || row.name || row.id.slice(0, 8))}</h2>${row.state ? badge(row.state) : ""}</div>
    <div class="actions"></div><div class="detail-body"></div>`;
  const actions = panel.querySelector(".actions"), body = panel.querySelector(".detail-body");
  const add = (name, fn) => actions.append(button(name, fn));
  const act = async (action, extra = {}, key) => {
    await mutation(`/${type}/${id}/actions`, "POST", { action, version: row.version, ...extra }, key);
    await refresh(); await detail(type, id); notice("操作成功");
  };
  const formAction = (name, html, save) => {
    const key = crypto.randomUUID();
    openEditor(name, html, async values => {
      await save(values, key); await refresh(); await detail(type, id); notice("操作成功");
    });
  };
  if (["orders", "quotes", "purchases"].includes(type)) {
    body.innerHTML = facts([["单据版本", row.version], ["金额", `${row.total} ${row.currency}`], ["交期", row.due_date || "未设置"], ["贸易条款", row.terms]])
      + '<div class="table-scroll" id="document-lines"></div><div id="events"></div>';
    $("#document-lines").append(table([
      column("name", "商品"), column("unit", "单位"), ...["quantity", "price", "amount", "reserved", "shipped", "received", "shortage"].map((k, i) =>
        column(k, ["订购量", "单价", "金额", "占用", "已发货", "已收货", "缺货"][i], { num: true, value: x => qty(x[k]) })),
    ], row.lines));
    if (row.lead_id) add("查看来源询盘", async () => { await navigate("leads"); await detail("leads", row.lead_id); });
    if (type === "orders" && row.source_id) add("查看来源报价", async () => { await navigate("quotes"); await detail("quotes", row.source_id); });
    if (["orders", "purchases"].includes(type) && can(type === "purchases" ? "purchasing" : "sales", "auditor")) {
      const docs = mountDocuments(body, { row, type, api, mutation, current: () => selected === row && sequence === detailSequence });
      documentsView = docs;
      add("单证档案", docs.load);
      if (can(type === "purchases" ? "purchasing" : "sales") && ["confirmed", "partial", "fulfilled", "completed"].includes(row.state)) add("生成单证", docs.issue);
    }
    if (editable(type) && ["draft", "review", "confirmed", "partial", "sent"].includes(row.state)) add("修改单据", () => editTrade(type, row));
    if (type === "quotes") {
      if (can("sales") && row.state === "draft") add("发送报价", () => act("send"));
      if (can("sales") && row.state === "sent") add("接受并转订单", async () => {
        const result = await mutation(`/quotes/${id}/actions`, "POST", { action: "accept", version: row.version });
        await navigate("orders"); await detail("orders", result.order_id);
      });
    } else {
      if (editable(type) && row.state === "draft") add("提交审核", () => act("submit"));
      if (can() && row.state === "review") {
        add("审核通过", () => act("approve"));
        add("驳回", () => formAction("驳回原因", field("reason", "原因", ""), (v, key) => act("reject", v, key)));
      }
      if (type === "orders" && can("purchasing") && ["confirmed", "partial"].includes(row.state)) add("生成采购", async () => {
        const suppliers = (await all("partners")).filter(p => p.kind !== "customer");
        if (!suppliers.length) throw new Error("请先建立供应商");
        const key = crypto.randomUUID();
        const shortage = row.lines.filter(line => Number(line.shortage) > 0);
        if (!shortage.length) throw new Error("当前没有未安排的采购缺口");
        openEditor("按缺口生成采购", field("supplier_id", "供应商", "", { options: selectOptions(suppliers) })
          + field("currency", "采购币种", row.currency, { options: currencies })
          + '<p class="full summary-note">请填写供应商报价。销售单价不会作为采购价；采购币种可以与销售不同。</p>'
          + shortage.map((line, i) => `<p class="summary-note">${esc(line.name)} · 缺口 ${qty(line.shortage)}</p>`
            + field(`supplier-price-${i}`, "供应商单价", "")).join(""), async values => {
          const p = await mutation(`/orders/${id}/procure`, "POST", {
            supplier_id: values.supplier_id, currency: values.currency, version: row.version,
            prices: shortage.map((line, i) => ({ order_line_id: line.id, price: values[`supplier-price-${i}`] })),
          }, key);
          await navigate("purchases"); await detail("purchases", p.id);
        });
      });
      const receive = type === "purchases";
      if (can(...(receive ? ["purchasing", "warehouse"] : ["warehouse"])) && ["confirmed", "partial"].includes(row.state)) {
        add(receive ? "收货入库" : "出库发货", () => {
          const key = crypto.randomUUID();
          formAction(receive ? "登记到货" : "登记发货", row.lines.map((l, i) => field(`quantity-${i}`, "本次数量", "0")
            + `<p class="summary-note">${esc(l.name)} · ${receive ? "已收" : "已占用"} ${qty(receive ? l.received : l.reserved)}</p>`).join(""),
          values => mutation(`/${type}/${id}/${receive ? "receive" : "ship"}`, "POST", {
            version: row.version, lines: row.lines.map((l, i) => ({ line_id: l.id, quantity: values[`quantity-${i}`] })).filter(l => Number(l.quantity) > 0),
          }, key));
        });
      }
      if (editable(type) && row.state === "fulfilled") add("完成单据", () => act("complete"));
    }
    if (editable(type) && ["draft", "review", "confirmed", "partial", "sent"].includes(row.state)) {
      add("取消剩余", () => formAction("确认取消", '<p class="full summary-note">将取消未履约部分并释放相应占用。已发生收发货历史保留。</p>', (v, key) => act("cancel", {}, key)));
    }
    add("历史版本", async () => {
      const history = await api(`/${type}/${id}/versions`);
      $("#events").innerHTML = "<h3>历史版本</h3>";
      $("#events").append(table([column("version", "版本"), column("state", "状态", { value: x => x.snapshot.state }), column("total", "当时金额", { value: x => `${x.snapshot.total} ${x.snapshot.currency}` }), dateColumn], history.items));
    });
    if (type !== "quotes") {
      const events = (await api(`/${type}/${id}/fulfilments`)).items;
      if (selected !== row) return;
      $("#events").innerHTML = "<h3>收发货及退货流水</h3>";
      $("#events").append(table([column("kind", "类型"), column("quantity", "数量", { value: x => qty(x.quantity) }), column("event_line_id", "来源编号"), dateColumn], events));
      if (can("warehouse")) {
        for (const [name, sourceKind, operation] of [[type === "orders" ? "销售退货" : "采购退货", type === "orders" ? "ship" : "receive", "return"], ["检验释放", "sales_return", "release-return"]]) {
          const sources = events.filter(e => e.kind === sourceKind);
          if (sources.length) add(name, () => {
            const key = crypto.randomUUID();
            formAction(name, field("source_line_id", "原始流水", "", { options: sources.map(e => ({ value: e.event_line_id, label: `${date(e.created_at)} · ${qty(e.quantity)}` })) })
              + field("quantity", "本次数量", "1") + field("reason", "原因", ""), values =>
              mutation(`/${type}/${id}/${operation}`, "POST", { version: row.version, reason: values.reason, lines: [{ source_line_id: values.source_line_id, quantity: values.quantity }] }, key));
          });
        }
      }
    }
  } else if (type === "contents") {
    body.innerHTML = facts([["语言", row.language], ["排期", date(row.scheduled_at)], ["发布来源", row.publication_source === "manual" ? "人工登记" : "未发布"], ["版本", row.version]])
      + `<p class="prose">${esc(row.body)}</p>${row.publication_url ? `<p class="summary-note">${esc(row.publication_url)}</p>` : ""}`;
    if (editable(type)) {
      if (["draft", "review", "approved", "scheduled"].includes(row.state)) add("编辑内容", () => editRecord(type, row));
      if (row.state === "draft") add("提交审核", () => act("submit"));
      if (row.state === "review" && can()) {
        add("审核通过", () => act("approve"));
        add("驳回", () => formAction("驳回内容", field("reason", "原因", ""), (v, key) => act("reject", v, key)));
      }
      if (["approved", "scheduled"].includes(row.state)) {
        add("发布排期", () => formAction("发布排期", field("scheduled_at", "计划时间", "", { type: "datetime-local" }),
          (v, key) => act("schedule", { scheduled_at: new Date(v.scheduled_at).toISOString() }, key)));
        add("登记人工发布", () => formAction("登记人工发布", field("url", "发布链接", "", { type: "url" }), (v, key) => act("publish_manual", v, key)));
      }
      if (row.state === "published") add("登记效果", () => {
        const today = new Date().toISOString().slice(0, 10);
        formAction("登记效果", field("period_start", "开始日期", today, { type: "date" }) + field("period_end", "结束日期", today, { type: "date" })
          + ["impressions", "interactions", "clicks", "leads"].map((k, i) => field(k, ["曝光", "互动", "点击", "线索"][i], "0")).join(""),
        (v, key) => mutation(`/contents/${id}/insights`, "POST", { ...v, version: row.version, ...Object.fromEntries(["impressions", "interactions", "clicks", "leads"].map(k => [k, Number(v[k])])) }, key));
      });
    }
    if (row.insights.length) {
      const h = document.createElement("h3"); h.textContent = "效果记录 · 人工来源"; body.append(h);
      body.append(table([column("period_start", "开始"), column("period_end", "结束"), column("impressions", "曝光"), column("clicks", "点击"), column("leads", "线索")], row.insights));
    }
  } else if (type === "members") {
    mountMember(body, actions, {
      row, userId: identity.user.id, mutation, signOut: clearSession,
      current: () => selected === row && sequence === detailSequence,
      changed: async () => { await refresh(); await detail(type, id); },
    });
  } else if (type === "leads") {
    body.innerHTML = facts([["联系方式", row.contact], ["下次跟进", date(row.next_followup_at)], ["版本", row.version]]) + `<p class="prose">${esc(row.need)}</p>`
      + "<h3>跟进记录</h3>" + row.followups.map(f => `<div class="event"><p class="prose">${esc(f.note)}</p><small>${esc(date(f.created_at))} · 下次 ${esc(date(f.due_at))}</small></div>`).join("");
    const source = mountWebsiteSource(body, id, api, () => selected === row && sequence === detailSequence);
    sourceView = source;
    add("查看官网来源", source.load);
    if (editable(type)) {
      add("编辑询盘", () => editRecord(type, row));
      add("新增跟进", () => formAction("新增跟进", field("note", "跟进内容", "", { type: "textarea", full: true })
        + field("due_at", "下次跟进", "", { type: "datetime-local", required: false }),
      (v, key) => mutation(`/leads/${id}/followups`, "POST", { note: v.note, due_at: v.due_at ? new Date(v.due_at).toISOString() : null, version: row.version }, key)));
      if (can("sales")) add("创建报价", async () => {
        if (!row.partner_id) throw new Error("请先明确绑定业务客户，再创建报价");
        await navigate("quotes"); await editTrade("quotes", { partner_id: row.partner_id }, row.id);
      });
      if (["new", "qualified"].includes(row.state)) {
        add("标记有效", () => act("qualify"));
        add("关闭询盘", () => formAction("关闭询盘", field("reason", "原因", ""), (v, key) => act("lose", v, key)));
      } else if (row.state === "lost") add("重新打开", () => act("reopen"));
    }
  } else if (type === "transfers" || type === "stocktakes") {
    body.innerHTML = type === "transfers" ? facts([["计划量", qty(row.quantity)], ["在途", qty(row.in_transit)], ["已收货", qty(row.received)], ["版本", row.version]])
      : `<p class="prose">${esc(row.reason)}</p>`;
    if (row.lines) body.append(table([column("product_id", "商品编号"), column("baseline_quantity", "账面数量"), column("counted", "实盘数量")], row.lines));
    if (can("warehouse")) {
      if (row.state === "draft") add(type === "transfers" ? "调拨发出" : "提交审核", () => act(type === "transfers" ? "ship" : "submit"));
      if (type === "transfers" && ["in_transit", "partial"].includes(row.state)) add("调拨到货", () => formAction("调拨到货", field("quantity", "本次数量", qty(row.in_transit)), (v, key) => act("receive", v, key)));
      if (type === "stocktakes" && row.state === "review" && can()) add("审核通过", () => act("approve"));
      if (["draft", ...(type === "stocktakes" ? ["review"] : [])].includes(row.state)) add("取消", () => act("cancel"));
    }
  } else {
    body.innerHTML = facts(Object.entries(row).filter(([k]) => !["tenant_id", "id", "created_at", "updated_at"].includes(k)));
    if (editable(type)) add("编辑资料", () => editRecord(type, row));
  }
}
async function settings() {
  const data = await api("/settings"); $("#pagination").replaceChildren();
  const area = document.createElement("div"); area.style.padding = "22px";
  area.innerHTML = `<h2>企业资料</h2><p class="summary-note">本企业独立配置，不影响其他企业。财务接入尚未联调，当前不传输银行或账务数据。</p>`
    + facts([["企业名称", data.data.company || identity.tenant.name], ["地址", data.data.address], ["版本", data.version]]);
  if (can()) area.append(button("编辑企业资料", () => editor("企业资料", field("company", "企业名称", data.data.company || identity.tenant.name)
    + field("address", "地址", data.data.address || "", { required: false }), (values, key) =>
    mutation("/settings", "PATCH", { version: data.version, data: { ...data.data, ...values } }, key).then(() => null))));
  $("#table-region").replaceChildren(area);
}
api("/bootstrap").then(enter).catch(() => {});

async function finance() {
  const [status, events, results] = await Promise.all([api("/finance/status"), api("/finance/events"), api("/finance/results")]);
  if (view !== "finance") return;
  $("#pagination").replaceChildren();
  const area = document.createElement("div"); area.style.padding = "18px";
  area.innerHTML = '<h2>东大财务 · 业务单据协同</h2><p class="summary-note">尚未完成财务端联调。待同步事件已持久化；已接收仅表示财务待审收件，不代表会计过账或付款。</p><h3>同步队列</h3>';
  const states = { pending: "待同步", sending: "发送中", accepted: "已接收待审", failed: "失败待重试", rejected: "被拒绝" };
  area.append(table([
    column("event_type", "业务动作"), column("document_version", "源版本"), column("state", "同步状态", { value: x => states[x.state] }),
    column("attempts", "尝试次数"), column("remote_id", "财务收件编号"), column("error_code", "异常码"), dateColumn,
  ], events.items));
  const h = document.createElement("h3"); h.textContent = "财务状态回传"; area.append(h);
  const resultStates = { pending_review: "待财务审核", approved: "已审核", rejected: "已拒绝", partially_settled: "部分核销", settled: "已核销", reversed: "已冲销" };
  area.append(table([
    column("financial_record_id", "财务记录"), column("source_version", "业务版本"), column("status", "状态", { value: x => resultStates[x.status] }),
    column("currency", "币种"), column("settled_amount", "累计核销", { value: x => qty(x.settled_amount), num: true }), dateColumn,
  ], results.items));
  $("#table-region").replaceChildren(area);
}
