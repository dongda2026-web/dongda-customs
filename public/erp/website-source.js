import { date } from "./ui.js";

const labels = {
  type: "请求类型", company: "企业", contact: "联系人", email: "邮箱", phone: "电话",
  product: "官网产品名称", productId: "官网产品标识（非内部 SKU）", quantity: "需求数量",
  quantityUnit: "数量单位", specifications: "原始规格", notes: "备注", language: "来源语言",
  page: "来源页面", items: "RFQ 商品明细", destination: "目的地", deliveryWindow: "交付窗口",
  sampleRequest: "样品申请", customization: "定制规格", lineId: "官网明细标识",
  purpose: "样品用途", expectedPurchaseQuantity: "预计采购量（非订单数量）",
  requirements: "样品要求", recipientName: "收件人", recipientPhone: "收件电话",
  country: "国家", city: "城市", address: "地址", postalCode: "邮编",
  costTermsAcknowledged: "样品费用条款确认", dimensionUnit: "尺寸单位",
  length: "长度", width: "宽度", height: "高度", material: "材料", bagColor: "袋色",
  printing: "印刷方式", printColors: "印刷色数", loadKg: "承重 (kg)",
  contents: "装载物", technicalAdvice: "需要技术建议", qty: "数量", size: "尺寸",
};
const types = { inquiry: "普通询盘", "ai-customer-service": "AI 客服需求",
  "quote-calculator": "产品报价 / 定制", "multi-product-rfq": "多产品 RFQ", "sample-request": "样品申请" };
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
function fields(value, path = "", depth = 0) {
  if (depth > 8) return node("p", JSON.stringify(value), "prose");
  const list = node("dl", null, "source-fields");
  for (const [key, item] of Object.entries(value || {})) {
    const fullPath = path ? `${path}.${key}` : key;
    const group = node("div"); group.dataset.sourceField = fullPath;
    const label = fullPath === "sampleRequest.quantity" ? "样品数量（非订单数量）" : labels[key] || key;
    group.append(node("dt", label));
    const detail = node("dd");
    if (Array.isArray(item)) {
      item.forEach((entry, i) => {
        const section = node("section", null, "source-item");
        section.append(node("h4", `明细 ${i + 1}`), fields(entry, `${fullPath}.${i}`, depth + 1));
        detail.append(section);
      });
    } else if (item && typeof item === "object") detail.append(fields(item, fullPath, depth + 1));
    else detail.textContent = key === "type" ? types[item] || String(item)
      : typeof item === "boolean" ? (item ? "是" : "否") : item == null || item === "" ? "未提供" : String(item);
    group.append(detail); list.append(group);
  }
  return list;
}

export function mountWebsiteSource(container, leadId, api, isCurrent) {
  const area = node("section", null, "website-source");
  area.id = "website-source"; area.tabIndex = -1;
  area.setAttribute("aria-label", "官网原始需求"); area.setAttribute("aria-live", "polite");
  container.append(area); area.hidden = true;
  let disposed = false, opened = false, sequence = 0;
  const current = n => !disposed && area.isConnected && isCurrent() && sequence === n;
  async function load(focus = false) {
    if (disposed || !isCurrent()) return;
    opened = true; const n = ++sequence;
    area.hidden = false;
    area.replaceChildren(node("p", "正在重新核验权限并读取官网来源…", "summary-note"));
    if (focus) { area.focus({ preventScroll: true }); area.scrollIntoView({ block: "nearest" }); }
    try {
      const source = await api(`/leads/${leadId}/website-source`);
      if (!current(n)) return;
      const metadata = fields({ siteId: source.siteId, sourceInquiryId: source.sourceInquiryId,
        receivedAt: date(source.receivedAt), schemaVersion: source.schemaVersion });
      area.replaceChildren(node("h3", "官网原始需求 · 只读"), metadata,
        node("p", "原始内容保持收件时状态。客户、内部商品、正式数量和价格需由员工明确确认；本页不会自动创建订单。", "summary-note"),
        fields(source.payload));
    } catch (error) {
      if (!current(n)) return;
      const message = error.status === 404 ? "无官网来源或无权查看；请核对当前负责人。"
        : error.status === 403 ? "没有查看官网来源的权限。"
        : "官网来源读取失败，请检查连接后重新查看。";
      area.replaceChildren(node("p", message, "summary-note"));
    }
  }
  function focus() { if (opened) void load(); }
  function visibility() {
    if (!opened || disposed) return;
    if (document.hidden) { sequence++; area.replaceChildren(node("p", "页面已离开，返回后重新核验来源权限。", "summary-note")); }
    else void load();
  }
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  return {
    load: () => load(true),
    dispose() {
      disposed = true; sequence++; area.replaceChildren();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
Object.assign(labels, { siteId: "来源站点", sourceInquiryId: "官网回执编号", receivedAt: "收件时间", schemaVersion: "来源协议版本" });
