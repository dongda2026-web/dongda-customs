"use strict";
const escape = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const labels = {
  en: ["COMMERCIAL INVOICE", "PACKING LIST", "PURCHASE ORDER", "Seller", "Buyer", "Description", "Quantity", "Unit", "Price", "Amount", "Total", "Date", "Terms", "Packages", "Gross kg", "Net kg", "Marks"],
  zh: ["商业发票", "装箱单", "采购单", "卖方", "买方", "商品名称", "数量", "单位", "单价", "金额", "合计", "日期", "条款", "件数", "毛重 kg", "净重 kg", "唛头"],
  ru: ["КОММЕРЧЕСКИЙ ИНВОЙС", "УПАКОВОЧНЫЙ ЛИСТ", "ЗАКАЗ НА ПОКУПКУ", "Продавец", "Покупатель", "Наименование", "Количество", "Ед.", "Цена", "Сумма", "ИТОГО", "Дата", "Условия", "Мест", "Брутто кг", "Нетто кг", "Маркировка"],
};
function render(s) {
  const l = labels[s.language], packing = s.kind === "packing_list";
  const title = l[s.kind === "invoice" ? 0 : packing ? 1 : 2];
  const party = (label, p) => `<section><h2>${escape(label)}</h2><p>${escape(p.name)}</p><p>${escape(p.address)}</p></section>`;
  return `<!doctype html><html lang="${s.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(s.number)} - ${escape(title)}</title><style>
@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#202b30;margin:24px;line-height:1.5;font-size:12px}
h1{font-size:23px;border-bottom:2px solid #33484f;padding-bottom:12px}h2{font-size:12px;color:#52656b}p{white-space:pre-wrap;overflow-wrap:anywhere}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px}table{border-collapse:collapse;width:100%;margin:20px 0;table-layout:fixed}
th,td{border:1px solid #aebac0;padding:7px;text-align:left;overflow-wrap:anywhere}th{background:#eff3f4}.num{text-align:right}
thead{display:table-header-group}tr{break-inside:avoid}footer{border-top:1px solid #aebac0;padding-top:10px;font-size:10px;color:#52656b}
@media(max-width:500px){body{margin:12px}.parties{grid-template-columns:1fr}td,th{padding:4px}}
</style></head><body><h1>${escape(title)}</h1><p>${escape(s.number)} · ${escape(l[11])}: ${escape(s.issue_date)}</p>
<div class="parties">${party(l[3], s.seller)}${party(l[4], s.buyer)}</div>
<p>${escape(l[12])}: ${escape(s.terms)}</p>
<table><thead><tr><th>#</th><th>${escape(l[5])}</th><th>${escape(l[6])}</th><th>${escape(l[7])}</th>${packing ? "" : `<th>${escape(l[8])}</th><th>${escape(l[9])}</th>`}</tr></thead><tbody>
${s.lines.map((line, i) => `<tr><td>${i + 1}</td><td>${escape(line.name)}</td><td class="num">${escape(line.quantity)}</td><td>${escape(line.unit)}</td>${packing ? "" : `<td class="num">${escape(line.price)}</td><td class="num">${escape(line.amount)}</td>`}</tr>`).join("")}
</tbody></table>${packing ? `<p>${escape(l[13])}: ${escape(s.packing.packages)} · ${escape(l[14])}: ${escape(s.packing.gross_kg)} · ${escape(l[15])}: ${escape(s.packing.net_kg)}</p><p>${escape(l[16])}: ${escape(s.packing.marks)}</p>`
    : `<p class="num"><strong>${escape(l[10])}: ${escape(s.total)} ${escape(s.currency)}</strong></p>`}
<footer>Snapshot ${escape(s.source.number)} / v${s.source.version}${s.source.fulfilment_id ? ` / ${escape(s.source.fulfilment_id)}` : ""} · ${escape(s.template_version)}
<p>Immutable business snapshot. Current validity must be checked in the ERP before use. No official seal or customs certification is included.</p></footer></body></html>`;
}
module.exports = { render };
