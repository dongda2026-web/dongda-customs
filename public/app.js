/* 东大制单工作台 · 前端逻辑 v1.0 */
"use strict";
const $=id=>document.getElementById(id);
const fmt=n=>(+n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const today=()=>new Date().toISOString().slice(0,10);
const RATE_VERSION="2026-06-13";
const HS_DUTIES={
  "6305.32":{cn:"集装袋/吨袋 FIBC",ru:"Гибкие промежуточные контейнеры большой емкости",kzDuty:10,uzDuty:10,note:"EAEU 6305 32 1100/1900/9000 均为10%；乌方按10位码逐票核验"},
  "6305.33":{cn:"聚乙烯/聚丙烯条带编织袋",ru:"Мешки из полос полиэтилена или полипропилена",kzDuty:10,uzDuty:10,note:"EAEU 6305 33 1001/1009/9000 均为10%；乌方按10位码逐票核验"},
  "6305.39":{cn:"其他化纤包装袋",ru:"Прочие мешки из химических текстильных материалов",kzDuty:7,uzDuty:10,note:"EAEU 6305 39 0000 为7%；若实际为吨袋/PP编织袋需优先核对6305.32/6305.33"},
  "3923.21":{cn:"聚乙烯塑料袋",ru:"Пакеты из полиэтилена",kzDuty:6.5,uzDuty:10,note:"塑料袋类，需与纺织编织袋区分"},
  "3923.29":{cn:"其他塑料袋",ru:"Прочие пакеты из пластмасс",kzDuty:6.5,uzDuty:10,note:"塑料袋类，需与纺织编织袋区分"}
};
const SOURCE_NOTES={
  cn:"中国：出口报关单按海关总署《进出口货物报关单填制规范》栏目口径；出口退税以国家税务总局出口货物劳务退税率文库和报关单出口日期为准。",
  kz:"哈萨克斯坦：进口税则按 ЕТТ ЕАЭС；6305.32/6305.33 为10%，6305.39 为7%。НДС 基准税率按2026税法改革采用16%。",
  uz:"乌兹别克斯坦：НДС 12%；进口关税必须按 tarif.customs.uz 的10位 ТН ВЭД 逐票核验。对乌出口务必准备CO/原产地资料，避免优惠或原产地审查风险。"
};
const HS_NOTE="合规库核验日期："+RATE_VERSION+"\n\n"+Object.entries(HS_DUTIES).map(([hs,x])=>hs+" · "+x.cn+" · KZ "+x.kzDuty+"% / UZ核验基准 "+x.uzDuty+"%\n  "+x.note).join("\n")+"\n\n"+SOURCE_NOTES.cn+"\n"+SOURCE_NOTES.kz+"\n"+SOURCE_NOTES.uz+"\n申报税率最终以海关、брокер、税务机关核定为准。";

/* ================= 基础资料 ================= */
const DEF_COMPANY={
  ex:{name:"新疆立天东大贸易有限公司",lat:"Xinjiang Litian Dongda Trade Co., Ltd",addr:"中国新疆",bank:"",swift:"",acct:"",tax:""},
  im:{name:"Частная компания Dongda Ltd.",addr:"г. Астана, ул. Сауран 3/1, оф.783",tel:"7 707 5590188",bin:"250840901034",bank:"АО «Банк ЦентрКредит»",iban:"KZ198562203148814317",bik:"KCJBKZKX"}
};
function loadCompany(){try{const raw=JSON.parse(localStorage.getItem("dd_company")||"{}"),c={ex:Object.assign({},DEF_COMPANY.ex,raw.ex||{}),im:Object.assign({},DEF_COMPANY.im,raw.im||{})};
  if(!c.im.tel)c.im.tel=DEF_COMPANY.im.tel;
  if(/Mangilik|Мангилик|55\/17/i.test(c.im.addr||""))c.im.addr=DEF_COMPANY.im.addr;
  return c;
}catch(e){return DEF_COMPANY}}
function fillCompanyForm(){const c=loadCompany();
  ["name","lat","addr","bank","swift","acct","tax"].forEach(k=>{const el=$("c_ex_"+k);if(el)el.value=c.ex[k]||""});
  ["name","addr","tel","bin","bank","iban","bik"].forEach(k=>{const el=$("c_im_"+k);if(el)el.value=c.im[k]||""});}
function saveCompany(){const c={ex:{},im:{}};
  ["name","lat","addr","bank","swift","acct","tax"].forEach(k=>{const el=$("c_ex_"+k);c.ex[k]=el?el.value.trim():""});
  ["name","addr","tel","bin","bank","iban","bik"].forEach(k=>{const el=$("c_im_"+k);c.im[k]=el?el.value.trim():""});
  if(!c.im.tel)c.im.tel=DEF_COMPANY.im.tel;
  localStorage.setItem("dd_company",JSON.stringify(c));toast("基础资料已保存 ✓");}

/* ================= 业务配置中心 ================= */
const DEF_CFG={prefix:"DD",seal:"",pin:"",
  ports:[["霍尔果斯","Хоргос"],["阿拉山口","Алашанькоу"],["巴克图","Бакту"],["伊尔克什坦","Иркештам"]],
  terms:["CPT Алматы","CPT Астана","DAP Ташкент","DAP Самарканд","FCA 霍尔果斯","FCA 阿拉山口","EXW 工厂","CIF"],
  hs:["6305.33","6305.32","6305.39","3923.21","3923.29"],
  clients:[["TOO «KazPack Trade»","KZ"],["OOO «Samarkand Agro»","UZ"]]};
function loadCfg(){try{const c=JSON.parse(localStorage.getItem("dd_cfg")||"null");return c&&c.ports?c:JSON.parse(JSON.stringify(DEF_CFG))}catch(e){return JSON.parse(JSON.stringify(DEF_CFG))}}
function fillCfgForm(){const c=loadCfg();if(!$("c_prefix"))return;
  $("c_prefix").value=c.prefix;$("c_seal").value=c.seal;$("c_pin").value=c.pin;
  $("c_ports").value=c.ports.map(p=>p[0]+"="+p[1]).join("\n");
  $("c_terms").value=c.terms.join("\n");
  $("c_hs").value=c.hs.join("\n");
  $("c_clients").value=c.clients.map(p=>p[0]+"|"+p[1]).join("\n");}
function saveCfg(){const c=loadCfg();
  c.prefix=($("c_prefix").value.trim()||"DD").toUpperCase();
  c.seal=$("c_seal").value.trim();c.pin=$("c_pin").value.trim();
  c.ports=$("c_ports").value.split("\n").map(l=>l.split("=").map(s=>s.trim())).filter(p=>p[0]).map(p=>[p[0],p[1]||p[0]]);
  c.terms=$("c_terms").value.split("\n").map(s=>s.trim()).filter(Boolean);
  c.hs=$("c_hs").value.split("\n").map(s=>s.trim()).filter(Boolean);
  c.clients=$("c_clients").value.split("\n").map(l=>l.split("|").map(s=>s.trim())).filter(p=>p[0]).map(p=>[p[0],(p[1]||"KZ").toUpperCase()]);
  if(!c.ports.length||!c.terms.length||!c.hs.length){alert("口岸/条款/HS库不能为空");return}
  localStorage.setItem("dd_cfg",JSON.stringify(c));
  applyCfg();drawItems();render();toast("业务配置已保存，全系统已生效 ✓");}
function resetCfg(){if(!confirm("恢复默认业务配置？"))return;localStorage.removeItem("dd_cfg");fillCfgForm();applyCfg();drawItems();render();toast("已恢复默认配置")}
function applyCfg(){const c=loadCfg();
  // 口岸下拉
  const port=$("f_port"),pv=port.value;
  port.innerHTML=c.ports.map(p=>`<option>${p[0]}</option>`).join("");
  if([...port.options].some(o=>o.value===pv))port.value=pv;
  // 条款下拉
  const terms=$("f_terms"),tv=terms.value;
  terms.innerHTML=c.terms.map(t=>`<option>${t}</option>`).join("");
  if(tv&&[...terms.options].some(o=>o.value===tv))terms.value=tv;
  // 客户联想
  const dl=$("clientList");if(dl)dl.innerHTML=c.clients.map(p=>`<option value="${p[0]}">`).join("");}
function getHS(){return loadCfg().hs}
function portRuOf(p){const c=loadCfg();const f=c.ports.find(x=>x[0]===p);return f?f[1]:(PORT_RU[p]||p)}
function wipeAll(){if(!confirm("⚠ 将清空全部票据、配置、税率、公司信息，且不可恢复。建议先导出备份。确定？"))return;
  if(!confirm("再次确认：真的要清空全部数据？"))return;
  ["dd_tickets","dd_doc_history","dd_cfg","dd_rates","dd_company","dd_api"].forEach(k=>localStorage.removeItem(k));
  location.reload();}
let adminOk=false;

/* ================= 税率库（核验于2026-06-13，法规依据见basis） ================= */
const DEF_RATES={
  version:RATE_VERSION,
  kz:{duty:10,vat:16,dutyBasis:"ЕТТ ЕАЭС · 6305.32/6305.33 = 10%，6305.39 = 7%；按10位ТН ВЭД最终确认",vatBasis:"НДС 16% · 哈萨克斯坦2026税法改革基准税率；特殊低税率商品需另核"},
  uz:{duty:10,vat:12,dutyBasis:"tarif.customs.uz · 按10位ТН ВЭД逐票核验；本系统仅给6305包装袋常用测算基准",vatBasis:"НДС 12% · 乌兹别克斯坦进口环节增值税；优惠/附加措施以海关核定为准"},
  checked:RATE_VERSION};
function loadRates(){try{const raw=JSON.parse(localStorage.getItem("dd_rates")||"null"),d=JSON.parse(JSON.stringify(DEF_RATES));
  if(raw&&raw.kz&&raw.uz){
    d.kz.duty=+raw.kz.duty||d.kz.duty;d.kz.vat=+raw.kz.vat||d.kz.vat;
    d.uz.duty=+raw.uz.duty||d.uz.duty;d.uz.vat=+raw.uz.vat||d.uz.vat;
    d.checked=raw.version===RATE_VERSION&&raw.checked?raw.checked:RATE_VERSION;
  }
  return d;
}catch(e){return JSON.parse(JSON.stringify(DEF_RATES))}}
function fillRatesForm(){const r=loadRates();
  if(!$("r_kz_duty"))return;
  $("r_kz_duty").value=r.kz.duty;$("r_kz_vat").value=r.kz.vat;$("r_uz_duty").value=r.uz.duty;$("r_uz_vat").value=r.uz.vat;
  $("rateVerify").innerHTML="🛡 当前合规库："+r.checked+" · KZ: ЕТТ ЕАЭС 6305.32/6305.33=10%、6305.39=7%，НДС16%；UZ: НДС12%，关税按10位码在 tarif.customs.uz 逐票核验。";}
function saveRates(){const r=loadRates();
  r.kz.duty=+$("r_kz_duty").value||r.kz.duty;r.kz.vat=+$("r_kz_vat").value||r.kz.vat;
  r.uz.duty=+$("r_uz_duty").value||r.uz.duty;r.uz.vat=+$("r_uz_vat").value||r.uz.vat;
  r.checked=today();r.version=RATE_VERSION;localStorage.setItem("dd_rates",JSON.stringify(r));
  fillRatesForm();render();toast("税率已更新并记录核验日期 ✓");}
function rateStale(){const r=loadRates();return (Date.now()-new Date(r.checked))/864e5>60}

/* ================= 票据状态 ================= */
let items=[],tplState={},curTicket=null,curDoc="inv";
function ticketNo(){const d=today().replace(/-/g,""),px=loadCfg().prefix;const n=tickets().filter(t=>t.no&&t.no.includes(d)).length+1;return px+"-"+d+"-"+String(n).padStart(2,"0")}
function newTicket(type){
  const c=loadCompany();type=type||"export";
  curTicket={id:Date.now(),no:ticketNo(),type,status:"doc",warnings:[],
    sellerInfo:type==="export"?{name:c.ex.name,lat:c.ex.lat,bank:c.ex.bank,swift:c.ex.swift,account:c.ex.acct}:{},
    buyerInfo:type==="import"?{name:c.im.name,addr:c.im.addr,bin:c.im.bin,bank:c.im.bank,iban:c.im.iban,bik:c.im.bik}:{},
    created:Date.now()};
  items=[{name:"PP编织袋 50kg 白色 55×95cm 复膜",hs:"6305.33",qty:10000,price:0.22}];
  tplState={};
  $("f_type").value=type;$("f_contract").value="";$("f_date").value=today();
  $("f_cur").value=type==="import"?"CNY":"USD";$("f_pay").value=type==="import"?"货到付款":"T/T 30%预付 70%发货前";
  $("f_truck").value="";$("f_gw").value="";$("f_nw").value="";$("f_pkg").value="";
  applyTypeNames();drawItems();render();
}
function applyTypeNames(){const c=loadCompany(),t=$("f_type").value;
  if(t==="export"){$("f_seller").value=c.ex.name;if(!$("f_buyer").value)$("f_buyer").value="";}
  else{$("f_buyer").value=c.im.name;if(!$("f_seller").value)$("f_seller").value="";}}
function onTypeChange(){if(curTicket)curTicket.type=$("f_type").value;applyTypeNames();render()}

/* ================= 货物明细 ================= */
/* HS编码库改由配置中心提供：getHS() */
function drawItems(){
  const tb=document.querySelector("#itemsTbl tbody");tb.innerHTML="";
  items.forEach((it,i)=>{
    tb.insertAdjacentHTML("beforeend",`<tr>
      <td style="min-width:190px"><input value="${esc(it.name)}" placeholder="品名/规格(中文)" oninput="items[${i}].name=this.value;render()">
      <input value="${esc(it.nameRu||'')}" placeholder="Наименование (俄文·哈乌单证用)" style="margin-top:5px" oninput="items[${i}].nameRu=this.value;render()"></td>
      <td style="width:110px"><select onchange="items[${i}].hs=this.value;render()">${getHS().map(h=>`<option ${h===it.hs?"selected":""}>${h}</option>`).join("")}</select></td>
      <td style="width:100px"><input class="num" inputmode="numeric" value="${it.qty}" oninput="items[${i}].qty=+this.value||0;render()"></td>
      <td style="width:90px"><input class="num" inputmode="decimal" value="${it.price}" oninput="items[${i}].price=+this.value||0;render()"></td>
      <td class="num"><b>${fmt(it.qty*it.price)}</b></td>
      <td style="width:30px;text-align:center;color:#bbb;cursor:pointer" onclick="delItem(${i})">✕</td></tr>`);
  });
}
function delItem(i){items.splice(i,1);if(!items.length)items.push({name:"",nameRu:"",hs:"6305.33",qty:0,price:0});drawItems();render()}
function addRow(){items.push({name:"PP集装袋(吨袋) 90×90×110cm 四吊带",hs:"6305.32",qty:1000,price:3.2});drawItems();render()}
function total(){return items.reduce((s,it)=>s+it.qty*it.price,0)}
function esc(s){return String(s||"").replace(/"/g,"&quot;").replace(/</g,"&lt;")}
function hs6(h){const d=String(h||"").replace(/\D/g,"");return d.length>=6?d.slice(0,4)+"."+d.slice(4,6):"6305.33"}
function dutyFor(country,hs){const x=HS_DUTIES[hs6(hs)];return x?(country==="KZ"?x.kzDuty:x.uzDuty):loadRates()[country==="KZ"?"kz":"uz"].duty}
function hsInfo(h){return HS_DUTIES[hs6(h)]||{cn:"需人工核对",ru:"Проверить код",note:"不在常用编码库，需按官方税则核验"}}
function taxCalc(country,amount,hs){const R=loadRates(),dutyRate=dutyFor(country,hs),vatRate=country==="KZ"?R.kz.vat:R.uz.vat;
  const duty=amount*dutyRate/100,vat=(amount+duty)*vatRate/100;
  return{dutyRate,vatRate,duty,vat,total:duty+vat,basis:(country==="KZ"?R.kz.dutyBasis+"；"+R.kz.vatBasis:R.uz.dutyBasis+"；"+R.uz.vatBasis)}}
function taxTotals(country){return items.reduce((s,it)=>{const c=taxCalc(country,it.qty*it.price,it.hs);s.duty+=c.duty;s.vat+=c.vat;s.total+=c.total;s.rates.add(c.dutyRate+"%");return s},{duty:0,vat:0,total:0,rates:new Set()})}

/* ================= 模版选择 ================= */
const TPLS={
  common:[
    {id:"inv",t:"商业发票 Инвойс",d:"中俄双语国际通行格式",ver:"双语版 v3 · 现行有效",must:true},
    {id:"pkl",t:"装箱单 Упаковочный лист",d:"中俄双语，含件数/毛净重",ver:"双语版 v3 · 现行有效",must:true},
    {id:"dec",t:"中国出口报关单（草单）",d:"横版A4 · 单一窗口申报项目齐全",ver:"《填制规范》现行版",must:true},
    {id:"cmr",t:"CMR 国际公路运输单",d:"КДПГ公约标准格式",ver:"标准格式 · 现行有效",must:false,on:true},
    {id:"ysys",t:"申报要素表（编织袋/吨袋）",d:"材质PP、克重、规格、用途",ver:"按6305/3923预设",must:false,on:true},
    {id:"co",t:"原产地证 CO 申请资料",d:"签发申请所需信息整理",ver:"现行版",must:false,on:true},
    {id:"origin",t:"原产地/非优惠声明",d:"给客户、брокер或贸促会核对原产地信息",ver:"CO辅助资料",must:false,on:false},
    {id:"tax",t:"进口税费测算表",d:"KZ/UZ 关税、НДС、编码依据与风险提示",ver:"税费库 "+RATE_VERSION,must:false,on:true},
    {id:"check",t:"通关合规核验清单",d:"装运前逐项核对合同、金额、HS、CO、运输、银行资料",ver:"三国合规清单",must:false,on:true},
  ],
  KZ:[{id:"bro",t:"哈方 ДТ 申报资料包",d:"ЕАЭС统一格式各栏整理，брокер经ASTANA-1录入",ver:"ЕАЭС Решение №257 现行版",must:true},
      {id:"broker",t:"哈方报关代理委托资料",d:"给哈国брокер的俄文委托/资料清单",ver:"KZ broker pack",must:false,on:true}],
  UZ:[{id:"bro",t:"乌方 ГТД 申报资料包（Форма Т-6）",d:"e-BYuD电子申报所需字段整理表",ver:"Форма Т-6 现行版",must:true},
      {id:"broker",t:"乌方报关代理委托资料",d:"给乌国брокер的俄文委托/资料清单",ver:"UZ broker pack",must:false,on:true}],
};
function tplList(){
  const isExp=$("f_type").value==="export";
  return TPLS.common.map(t=>t.id==="dec"?Object.assign({},t,{must:isExp,on:true,d:isExp?t.d:t.d+"（进口票：由中方卖方报关，可选生成供核对）"}):t)
    .concat(TPLS[$("f_country").value]||[]);
}
function drawTpls(){
  const g=$("tplGrid");if(!g)return;
  $("tplVerify").innerHTML="🛡 模版库版本核验："+today()+" 已与官方发布比对（海关总署公告 / ЕАЭС Решение №257 / Lex.uz）· 全部为现行有效格式";
  const list=tplList();
  list.forEach(t=>{if(!(t.id in tplState))tplState[t.id]=t.must||t.on!==false});
  g.innerHTML=list.map(t=>{
    const on=t.must||tplState[t.id];
    return `<div class="tpl ${on?"on":""} ${t.must?"must":""}" onclick="tplToggle('${t.id}',${!!t.must})">
      <div class="ck">${on?"✓":""}</div>
      <div><div class="tt">${t.t}</div><div class="td">${t.d}</div>
      <span class="ver">🛡 ${t.ver}</span>${t.must?'<span class="ver req">必选</span>':""}</div></div>`;
  }).join("");
  $("tplCnt").textContent="将生成 "+selectedTpls().length+" 种单证";
}
function tplToggle(id,must){if(must)return;tplState[id]=!tplState[id];drawTpls();drawTabs()}
function selectedTpls(){return tplList().filter(t=>t.must||tplState[t.id])}

/* ================= 合同模版参数 ================= */
const CONTRACT_TPLS=[
  {id:"purchase",type:"import",name:"货物采购合同",sub:"按上传的采购合同版式拟定 · 我方 Dongda Ltd. 为买方",hint:"采购模版：适合哈国东大向中国供应商采购，自动生成进口采购票。",
    params:[
      ["contract","合同编号","DD-PUR-"+today().replace(/-/g,""),"合同首页编号 / Contract No."],
      ["place","签约地点","中国·新疆·阿克苏","签约地点"],
      ["date","签订日期",today(),"YYYY-MM-DD"],
      ["seller","供方 / 卖方","Aksu Xinghua Import and Export Trade Co., Ltd.","中国供应商名称"],
      ["seller_addr","供方地址","新疆阿克苏地区阿克苏纺织工业城静湖社区纺织大道以西、华孚路南侧纺织发展大厦A座八层801-5室","营业执照地址"],
      ["seller_tax","供方税号/统一社会信用代码","91652900MAE7897NXT","统一社会信用代码"],
      ["seller_bank","供方开户行","中国银行新疆阿克苏地区分行","开户行名称"],
      ["seller_swift","供方 SWIFT","BKCHCNBJ760","银行 SWIFT"],
      ["seller_account","供方银行账号","107106450600","银行账号"],
      ["buyer","需方 / 买方",DEF_COMPANY.im.name,"哈国 Dongda Ltd."],
      ["buyer_addr","需方地址",DEF_COMPANY.im.addr,"公司注册地址"],
      ["buyer_tax","需方税号/BIN",DEF_COMPANY.im.bin,"BIN / Tax ID"],
      ["buyer_bank","需方开户行",DEF_COMPANY.im.bank,"银行名称"],
      ["buyer_iban","需方 IBAN",DEF_COMPANY.im.iban,"IBAN"],
      ["buyer_bik","需方 BIK",DEF_COMPANY.im.bik,"BIK"],
      ["country","目的国","KZ","KZ 或 UZ"],
      ["terms","交货条款","CPT Астана","Incoterms + 目的地"],
      ["delivery","交货期限","2026年7月15日前","交货日期/期限"],
      ["cur","币种","CNY","CNY / USD / RUB / EUR"],
      ["pay","付款方式","货到付款","预付款、货到付款或分期付款"],
      ["goods","货物名称","PP编织袋 50kg 白色 55×95cm 复膜","合同货物名称、规格型号"],
      ["hs","HS编码","6305.33","报关建议编码"],
      ["qty","数量","10000","数量"],
      ["price","单价","0.22","不含税/含税按合同约定"],
      ["pkg","包装","编织袋包装","包装方式"],
      ["gw","毛重","", "kg，可留空"],
      ["nw","净重","", "kg，可留空"],
      ["port","口岸/交货地","霍尔果斯","口岸或到货地"],
      ["trans","运输方式","公路卡航（中欧卡车）","公路、铁路、海运等"],
      ["quality","质量要求","卖方所供货物必须符合中国相关标准及买方确认的规格、样品或技术要求。","质量标准"],
      ["pack_clause","包装标准","采用适合长途陆路运输的包装，确保货物不散包、不破损、不受潮。","包装条款"],
      ["acceptance","验收条款","货物到达买方指定地点后，买方应在合理期限内完成数量、外观及规格验收；如有异议应及时书面通知卖方。","验收条款"],
      ["breach","违约责任","任一方违反本合同约定，应赔偿守约方因此遭受的直接损失；因不可抗力导致不能履约的，受影响方应及时通知并提供证明。","违约/不可抗力"],
      ["law","适用法律","中华人民共和国法律","适用法律"],
      ["dispute","争议解决","协商不成，提交卖方所在地有管辖权人民法院诉讼解决。","争议条款"]
    ]},
  {id:"sale",type:"export",name:"货物销售合同",sub:"中国公司为卖方 · 客户为买方",hint:"销售模版：适合中方向哈萨克斯坦/乌兹别克斯坦客户出口销售。",
    params:[
      ["contract","合同编号","DD-SALE-"+today().replace(/-/g,""),"Contract No."],
      ["place","签约地点","中国·新疆","签约地点"],
      ["date","签订日期",today(),"YYYY-MM-DD"],
      ["seller","卖方",DEF_COMPANY.ex.name,"中国出口公司"],
      ["seller_addr","卖方地址",DEF_COMPANY.ex.addr,"营业执照地址"],
      ["seller_tax","卖方税号/统一社会信用代码",DEF_COMPANY.ex.tax,"统一社会信用代码"],
      ["seller_bank","卖方开户行",DEF_COMPANY.ex.bank,"开户行名称"],
      ["seller_swift","卖方 SWIFT",DEF_COMPANY.ex.swift,"银行 SWIFT"],
      ["seller_account","卖方银行账号",DEF_COMPANY.ex.acct,"银行账号"],
      ["buyer","买方","TOO «KazPack Trade»","境外客户名称"],
      ["buyer_addr","买方地址","","注册地址"],
      ["buyer_tax","买方税号/BIN","","BIN / Tax ID"],
      ["buyer_bank","买方开户行","","银行名称"],
      ["buyer_iban","买方账号/IBAN","","Account / IBAN"],
      ["buyer_bik","买方 BIK/SWIFT","","BIK / SWIFT"],
      ["country","目的国","KZ","KZ 或 UZ"],
      ["terms","贸易条款","CPT Алматы","Incoterms + 目的地"],
      ["delivery","交货期限","合同生效后按双方确认的装运计划交货","交货日期/期限"],
      ["cur","币种","USD","USD / CNY / RUB / EUR"],
      ["pay","付款方式","T/T 30%预付 70%发货前","付款条款"],
      ["goods","货物名称","PP集装袋(吨袋) 90×90×110cm 四吊带","合同货物名称、规格型号"],
      ["hs","HS编码","6305.32","报关建议编码"],
      ["qty","数量","1000","数量"],
      ["price","单价","3.20","单价"],
      ["pkg","包装","托盘/打包带固定","包装方式"],
      ["gw","毛重","", "kg，可留空"],
      ["nw","净重","", "kg，可留空"],
      ["port","出口口岸","霍尔果斯","出口口岸"],
      ["trans","运输方式","公路卡航（中欧卡车）","公路、铁路、海运等"],
      ["quality","质量要求","货物应符合合同约定规格、双方确认样品及出口包装要求。","质量标准"],
      ["pack_clause","包装标准","卖方应采用适合国际运输的包装，保证货物在正常运输、装卸和仓储条件下完好。","包装条款"],
      ["acceptance","验收条款","买方应在收货后合理期限内完成验收；对数量、质量或规格有异议的，应及时提交书面证明。","验收条款"],
      ["breach","违约责任","任一方违反本合同约定，应赔偿守约方因此遭受的直接损失；因不可抗力导致不能履约的，受影响方应及时通知并提供证明。","违约/不可抗力"],
      ["law","适用法律","中华人民共和国法律","适用法律"],
      ["dispute","争议解决","协商不成，提交卖方所在地有管辖权人民法院诉讼解决。","争议条款"]
    ]}
];
let contractTplId="purchase",contractTplCollapsed=false,formTplCollapsed=false;
let contractLangLeft="cn",contractLangRight="ru",formLangLeft="cn",formLangRight="ru";
let sealMode="on",sealPosition="right";
let contractLines=[];
const ML={
  cn:{name:"中文",purchase:"货物采购合同",sale:"货物销售合同",sub:"东大受控文件",no:"合同编号",place:"签约地点",date:"签订日期",seller:"卖方",buyer:"买方",addr:"地址",tax:"税号/信用代码",bank:"开户行",swift:"SWIFT",account:"银行账号/IBAN",bik:"BIK/SWIFT",goods:"第一条 标的物",goodsText:"双方确认以下货物名称、规格、数量、单价及金额。",item:"货物名称",hs:"HS编码",qty:"数量",price:"单价",amount:"金额",total:"合同总金额",country:"目的国",pkg:"包装",weight:"毛重/净重",quality:"第二条 质量要求",pack:"第三条 包装标准",delivery:"第四条 交货与运输",payment:"第五条 结算与支付",acceptance:"第六条 验收",breach:"第七条 违约责任与不可抗力",law:"第八条 法律适用与争议解决",effective:"第九条 合同生效",effectiveText:"本合同自双方授权代表签字并加盖公章或合同专用章之日起生效；传真件、扫描件与原件具有同等效力。",sellerSeal:"卖方签章",buyerSeal:"买方签章"},
  ru:{name:"Русский",purchase:"ДОГОВОР ПОСТАВКИ ТОВАРА",sale:"ДОГОВОР КУПЛИ-ПРОДАЖИ ТОВАРА",sub:"Контролируемый документ Dongda",no:"№ договора",place:"Место подписания",date:"Дата подписания",seller:"Продавец",buyer:"Покупатель",addr:"Адрес",tax:"Налоговый номер / код",bank:"Банк",swift:"SWIFT",account:"Счет / IBAN",bik:"БИК / SWIFT",goods:"1. Предмет договора",goodsText:"Стороны согласовали наименование, спецификацию, количество, цену и сумму товара.",item:"Наименование товара",hs:"Код ТН ВЭД",qty:"Кол-во",price:"Цена",amount:"Сумма",total:"Общая сумма договора",country:"Страна назначения",pkg:"Упаковка",weight:"Брутто / нетто",quality:"2. Требования к качеству",pack:"3. Упаковка",delivery:"4. Поставка и транспортировка",payment:"5. Расчеты и оплата",acceptance:"6. Приемка",breach:"7. Ответственность и форс-мажор",law:"8. Применимое право и споры",effective:"9. Вступление в силу",effectiveText:"Договор вступает в силу после подписания уполномоченными представителями и проставления печати; скан-копия имеет силу оригинала.",sellerSeal:"Подпись/печать продавца",buyerSeal:"Подпись/печать покупателя"},
  en:{name:"English",purchase:"GOODS PURCHASE CONTRACT",sale:"GOODS SALES CONTRACT",sub:"Dongda controlled file",no:"Contract No.",place:"Place of signing",date:"Signing date",seller:"Seller",buyer:"Buyer",addr:"Address",tax:"Tax ID / registration code",bank:"Bank",swift:"SWIFT",account:"Account / IBAN",bik:"BIK / SWIFT",goods:"1. Subject matter",goodsText:"The parties confirm the goods, specifications, quantity, unit price and amount below.",item:"Description",hs:"HS code",qty:"Quantity",price:"Unit price",amount:"Amount",total:"Total contract amount",country:"Destination country",pkg:"Packaging",weight:"Gross / net weight",quality:"2. Quality requirements",pack:"3. Packaging standard",delivery:"4. Delivery and transport",payment:"5. Settlement and payment",acceptance:"6. Acceptance",breach:"7. Liability and force majeure",law:"8. Governing law and disputes",effective:"9. Effectiveness",effectiveText:"This contract becomes effective after signing by authorized representatives and affixing the company seal; scanned copies have the same legal effect as originals.",sellerSeal:"Seller signature/seal",buyerSeal:"Buyer signature/seal"},
  kk:{name:"Қазақша",purchase:"ТАУАР САТЫП АЛУ ШАРТЫ",sale:"ТАУАР САТУ ШАРТЫ",sub:"Dongda бақыланатын құжаты",no:"Шарт нөмірі",place:"Қол қою орны",date:"Қол қою күні",seller:"Сатушы",buyer:"Сатып алушы",addr:"Мекенжай",tax:"Салық нөмірі / тіркеу коды",bank:"Банк",swift:"SWIFT",account:"Шот / IBAN",bik:"BIK / SWIFT",goods:"1. Шарт нысанасы",goodsText:"Тараптар тауардың атауын, сипаттамасын, санын, бірлік бағасын және сомасын растайды.",item:"Тауар атауы",hs:"HS / ТН ВЭД коды",qty:"Саны",price:"Бірлік бағасы",amount:"Сома",total:"Шарттың жалпы сомасы",country:"Межелі ел",pkg:"Қаптама",weight:"Брутто / нетто салмақ",quality:"2. Сапа талаптары",pack:"3. Қаптама стандарты",delivery:"4. Жеткізу және тасымалдау",payment:"5. Есеп айырысу және төлем",acceptance:"6. Қабылдау",breach:"7. Жауапкершілік және форс-мажор",law:"8. Қолданылатын құқық және даулар",effective:"9. Күшіне енуі",effectiveText:"Шарт уәкілетті өкілдер қол қойып, мөр басылғаннан кейін күшіне енеді; сканерленген көшірме түпнұсқамен бірдей күшке ие.",sellerSeal:"Сатушы қолы/мөрі",buyerSeal:"Сатып алушы қолы/мөрі"}
};
function langName(k){return (ML[k]||ML.cn).name}
function setSelectVal(id,v){const el=$(id);if(el)el.value=v}
function syncTemplateLangSelects(){setSelectVal("contractLangLeft",contractLangLeft);setSelectVal("contractLangRight",contractLangRight);setSelectVal("formLangLeft",formLangLeft);setSelectVal("formLangRight",formLangRight);setSelectVal("sealMode",sealMode);setSelectVal("sealPosition",sealPosition)}
function setContractLang(side,v){if(side==="left")contractLangLeft=v;else contractLangRight=v;previewContractTemplate(false)}
function setFormLang(side,v){if(side==="left")formLangLeft=v;else formLangRight=v;drawFormTemplateLibrary()}
function setSealMode(v){sealMode=v==="none"?"none":"on";syncTemplateLangSelects();previewContractTemplate(false);drawDoc()}
function setSealPosition(v){sealPosition=["left","center","right"].includes(v)?v:"right";syncTemplateLangSelects();previewContractTemplate(false);drawDoc()}
function makeContractLine(src={}){
  return {name:src.name||src.goods||"PP集装袋(吨袋) 90×90×110cm 四吊带",nameRu:src.nameRu||"",spec:src.spec||"",hs:src.hs||"6305.32",qty:+src.qty||1,unit:src.unit||"条",price:+src.price||0,gw:src.gw||"",nw:src.nw||"",pkg:src.pkg||"",elements:src.elements||""};
}
function ensureContractLines(){
  if(contractLines.length)return;
  const d=contractParamData();
  contractLines=[makeContractLine({name:d.goods,hs:d.hs,qty:d.qty,price:d.price,gw:d.gw,nw:d.nw,pkg:d.pkg})];
}
function drawContractItems(){
  const tb=$("contractItemsBody");if(!tb)return;
  ensureContractLines();
  tb.innerHTML=contractLines.map((it,i)=>`<tr>
    <td><input value="${esc(it.name)}" oninput="contractLines[${i}].name=this.value;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.nameRu||"")}" placeholder="RU/EN/KZ" oninput="contractLines[${i}].nameRu=this.value;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.spec||"")}" placeholder="规格型号/参数" oninput="contractLines[${i}].spec=this.value;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.hs)}" oninput="contractLines[${i}].hs=this.value;previewContractTemplate(false)"></td>
    <td><input class="num" value="${esc(it.qty)}" inputmode="decimal" oninput="contractLines[${i}].qty=+this.value||0;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.unit||"条")}" oninput="contractLines[${i}].unit=this.value;previewContractTemplate(false)"></td>
    <td><input class="num" value="${esc(it.price)}" inputmode="decimal" oninput="contractLines[${i}].price=+this.value||0;previewContractTemplate(false)"></td>
    <td><input class="num" value="${esc(it.gw||"")}" oninput="contractLines[${i}].gw=this.value;previewContractTemplate(false)"></td>
    <td><input class="num" value="${esc(it.nw||"")}" oninput="contractLines[${i}].nw=this.value;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.pkg||"")}" oninput="contractLines[${i}].pkg=this.value;previewContractTemplate(false)"></td>
    <td><input value="${esc(it.elements||"")}" placeholder="材质/用途/品牌" oninput="contractLines[${i}].elements=this.value;previewContractTemplate(false)"></td>
    <td><button class="mini" onclick="copyContractItem(${i})">复制</button><button class="mini del" onclick="delContractItem(${i})" style="margin-top:4px">删</button></td>
  </tr>`).join("");
}
function addContractItem(){ensureContractLines();contractLines.push(makeContractLine({}));drawContractItems();previewContractTemplate(false)}
function copyContractItem(i){ensureContractLines();contractLines.splice(i+1,0,Object.assign({},contractLines[i]));drawContractItems();previewContractTemplate(false)}
function delContractItem(i){ensureContractLines();contractLines.splice(i,1);if(!contractLines.length)contractLines.push(makeContractLine({}));drawContractItems();previewContractTemplate(false)}
function syncContractItemsFromEntry(){
  contractLines=(items.length?items:[{name:"",hs:"6305.33",qty:0,price:0}]).map(it=>makeContractLine({name:it.name,nameRu:it.nameRu,hs:it.hs,qty:it.qty,price:it.price,gw:$("f_gw").value,nw:$("f_nw").value,pkg:$("f_pkg").value}));
  drawContractItems();previewContractTemplate(false);toast("已同步核对录入商品到合同明细");
}
function contractTpl(){return CONTRACT_TPLS.find(t=>t.id===contractTplId)||CONTRACT_TPLS[0]}
function drawContractTemplates(){
  const menu=$("contractTplMenu"),fields=$("contractFields");if(!menu||!fields)return;
  menu.innerHTML=CONTRACT_TPLS.map(t=>`<div class="contract-choice ${t.id===contractTplId?"on":""}" data-contract-id="${t.id}"><b>${t.name}</b><span>${t.sub}</span><small>${t.id===contractTplId&&!contractTplCollapsed?"点击折叠":"点击打开"}</small></div>`).join("");
  menu.querySelectorAll("[data-contract-id]").forEach(el=>el.onclick=e=>{e.preventDefault();e.stopPropagation();selectContractTemplate(el.dataset.contractId)});
  const t=contractTpl();
  const body=$("contractTplBody");if(body)body.style.display=contractTplCollapsed?"none":"block";
  $("contractTplVerify").innerHTML="🛡 合同模版参数：可从原合同/扫描件提取后填写；采购模版已按用户提供的货物采购合同用途拟定。";
  $("contractTplHint").textContent=t.name;
  syncTemplateLangSelects();
  drawContractBaseSources();
  $("contractParamList").innerHTML=t.params.map(p=>`<span>${p[1]}</span>`).join("")+["产品名称","外文品名","规格/参数","HS","数量","单位","单价","毛重","净重","包装","申报要素"].map(x=>`<span>${x}</span>`).join("");
  if(fields.dataset.tpl!==t.id){
    fields.dataset.tpl=t.id;
    const wideKeys=["goods","seller_addr","buyer_addr","quality","pack_clause","acceptance","breach","law","dispute"];
    fields.innerHTML=t.params.map(p=>`<div class="field ${wideKeys.includes(p[0])?"wide":""}"><label>${p[1]}</label><input id="ct_${p[0]}" value="${esc(p[2])}" placeholder="${esc(p[3]||p[1])}" oninput="previewContractTemplate(false)"></div>`).join("");
  }
  drawContractItems();
  if(!$("contractPreview").innerHTML)previewContractTemplate(false);
}
function selectContractTemplate(id){
  if(id===contractTplId)contractTplCollapsed=!contractTplCollapsed;
  else{contractTplId=id;contractTplCollapsed=false}
  const p=$("contractPreview");if(p)p.innerHTML="";
  drawContractTemplates();
}
function contractParamData(){
  const d={};contractTpl().params.forEach(p=>{const el=$("ct_"+p[0]);d[p[0]]=el?el.value.trim():p[2]});return d;
}
function contractLineData(){ensureContractLines();return contractLines.map(makeContractLine).filter(x=>x.name||x.hs||x.qty||x.price)}
function contractBaseOptions(){
  const c=loadCompany(),cur=collectSafe();
  return [
    {id:"tpl",name:"按当前合同模版默认值",data:null},
    {id:"purchase",name:"采购默认：Dongda Ltd. 买方 / 中国供应商卖方",data:{buyer:c.im.name,buyer_addr:c.im.addr,buyer_tax:c.im.bin,buyer_bank:c.im.bank,buyer_iban:c.im.iban,buyer_bik:c.im.bik,country:"KZ",cur:"CNY",terms:"CPT Астана",pay:"货到付款",port:"霍尔果斯",trans:"公路卡航（中欧卡车）"}},
    {id:"sale",name:"销售默认：立天东大卖方 / 境外客户买方",data:{seller:c.ex.name,seller_addr:c.ex.addr,seller_tax:c.ex.tax,seller_bank:c.ex.bank,seller_swift:c.ex.swift,seller_account:c.ex.acct,buyer:"TOO «KazPack Trade»",country:"KZ",cur:"USD",terms:"CPT Алматы",pay:"T/T 30%预付 70%发货前",port:"霍尔果斯",trans:"公路卡航（中欧卡车）"}},
    {id:"company",name:"公司资料：使用基础资料中的进出口公司信息",data:{seller:c.ex.name,seller_addr:c.ex.addr,seller_tax:c.ex.tax,seller_bank:c.ex.bank,seller_swift:c.ex.swift,seller_account:c.ex.acct,buyer:c.im.name,buyer_addr:c.im.addr,buyer_tax:c.im.bin,buyer_bank:c.im.bank,buyer_iban:c.im.iban,buyer_bik:c.im.bik,country:"KZ",cur:contractTplId==="purchase"?"CNY":"USD"}},
    {id:"current",name:"当前录入数据：从核对录入页读取",data:cur}
  ];
}
function collectSafe(){
  const val=id=>$(id)?$(id).value:"";
  const it=items[0]||{},c=loadCompany();
  return {seller:val("f_seller"),seller_addr:c.ex.addr,seller_tax:c.ex.tax,seller_bank:c.ex.bank,seller_swift:c.ex.swift,seller_account:c.ex.acct,
    buyer:val("f_buyer"),buyer_addr:c.im.addr,buyer_tax:c.im.bin,buyer_bank:c.im.bank,buyer_iban:c.im.iban,buyer_bik:c.im.bik,
    country:val("f_country"),contract:val("f_contract"),date:val("f_date"),terms:val("f_terms"),cur:val("f_cur"),pay:val("f_pay"),goods:it.name||"",hs:it.hs||"",qty:it.qty||"",price:it.price||"",pkg:val("f_pkg"),gw:val("f_gw"),nw:val("f_nw"),port:val("f_port"),trans:val("f_trans")};
}
function drawContractBaseSources(){
  const s=$("contractBaseSource");if(!s)return;
  const old=s.value||"tpl";
  s.innerHTML=contractBaseOptions().map(o=>`<option value="${o.id}">${esc(o.name)}</option>`).join("");
  if([...s.options].some(o=>o.value===old))s.value=old;
}
function setContractField(k,v){const el=$("ct_"+k);if(el&&v!==undefined&&v!==null&&String(v)!=="")el.value=v}
function applyContractBaseSource(){
  const s=$("contractBaseSource"),opt=contractBaseOptions().find(o=>o.id===(s&&s.value));
  if(!opt||!opt.data)return;
  Object.entries(opt.data).forEach(([k,v])=>setContractField(k,v));
  if(opt.id==="current")syncContractItemsFromEntry();
  previewContractTemplate(false);
  toast("基础信息已载入合同模版");
}
function applyContractTemplate(){
  const t=contractTpl(),d=contractParamData();
  if(!curTicket||curTicket.type!==t.type)newTicket(t.type);
  $("f_type").value=t.type;
  $("f_seller").value=d.seller||"";
  $("f_buyer").value=d.buyer||"";
  $("f_country").value=(d.country||"KZ").toUpperCase()==="UZ"?"UZ":"KZ";
  $("f_contract").value=d.contract||"";
  $("f_date").value=d.date||today();
  setSelectOrAdd($("f_terms"),d.terms||"CPT Алматы");
  $("f_cur").value=d.cur||"USD";
  $("f_pay").value=d.pay||"";
  $("f_trans").value=d.trans||"公路卡航（中欧卡车）";
  setSelectOrAdd($("f_port"),d.port||"霍尔果斯");
  $("f_gw").value=d.gw||"";
  $("f_nw").value=d.nw||"";
  $("f_pkg").value=d.pkg||"";
  ensureContractLines();
  items=contractLines.map(x=>({name:x.name||"",nameRu:x.nameRu||"",hs:x.hs||"6305.33",qty:+x.qty||0,price:+x.price||0}));
  curTicket.type=t.type;
  drawItems();render();go("p1");toast("已套用"+t.name+"参数，可继续核对保存");
}
function copyContractParams(){
  const t=contractTpl(),goods="商品明细：{{items[]: name,name_foreign,spec,hs,qty,unit,price,gw,nw,pkg,elements}}";
  const txt=t.name+" 参数清单\n"+t.params.map(p=>p[1]+"：{{"+p[0]+"}}").join("\n")+"\n"+goods;
  if(navigator.clipboard)navigator.clipboard.writeText(txt).then(()=>toast("参数清单已复制 ✓")).catch(()=>alert(txt));
  else alert(txt);
}

/* ================= 表单模版左侧选择 ================= */
const FORM_TPLS=[
  {id:"inv",group:"商务",name:"商业发票",desc:"中俄/英文可切换，合同号、买卖方、金额、条款自动带入"},
  {id:"pkl",group:"商务",name:"装箱单",desc:"货物、件数、毛重、净重、包装信息自动生成"},
  {id:"dec",group:"中国出口",name:"出口报关单草单",desc:"境内发货人、境外收货人、成交方式、商品编号、申报金额"},
  {id:"ysys",group:"中国出口",name:"申报要素表",desc:"品名、材质、规格、用途、品牌等报关申报要素"},
  {id:"cmr",group:"运输",name:"CMR 国际公路运输单",desc:"发货人、收货人、装卸地、随附单据、车辆信息"},
  {id:"bro",group:"进口申报",name:"KZ/UZ 申报资料表",desc:"给哈国/乌国报关代理的 ДТ/ГТД 录入资料"},
  {id:"broker",group:"进口申报",name:"报关代理委托资料",desc:"给 брокер 的俄文资料清单和核对要点"},
  {id:"co",group:"原产地",name:"CO 申请资料",desc:"原产地证申请所需出口商、收货人、路线、商品信息"},
  {id:"origin",group:"原产地",name:"原产地声明资料",desc:"非优惠原产地说明、生产依据和随附资料"},
  {id:"tax",group:"核算",name:"进口税费测算表",desc:"KZ/UZ 关税、НДС、税率依据和风险提示"},
  {id:"check",group:"核验",name:"通关合规核验清单",desc:"合同、HS、CO、运输、银行、税费逐项核对"}
];
const FORM_DESC={
  cn:{inv:"商业发票：合同号、买卖方、货物、金额、贸易条款自动带入。",pkl:"装箱单：货物、件数、毛重、净重、包装信息自动生成。",dec:"出口报关单草单：用于中国单一窗口预录入核对。",ysys:"申报要素表：品名、用途、材质、规格、品牌等要素。",cmr:"CMR国际公路运输单：发货人、收货人、装卸地、车辆信息。",bro:"KZ/UZ申报资料表：给进口国报关代理录入ДТ/ГТД。",broker:"报关代理委托资料：给брокер的资料清单和核对要点。",co:"CO申请资料：原产地证申请所需出口商、收货人、路线、商品信息。",origin:"原产地声明资料：非优惠原产地说明和生产依据。",tax:"进口税费测算表：KZ/UZ关税、НДС和税率依据。",check:"通关合规核验清单：合同、HS、CO、运输、银行、税费逐项核对。"},
  ru:{inv:"Инвойс: автоматически подставляет контракт, стороны, товар, сумму и условия поставки.",pkl:"Упаковочный лист: товар, места, брутто, нетто и упаковка.",dec:"Черновик экспортной декларации КНР: для проверки перед подачей в Single Window.",ysys:"Сведения о товаре: наименование, назначение, материал, спецификация и бренд.",cmr:"CMR: отправитель, получатель, места погрузки/разгрузки и транспорт.",bro:"Сведения для ДТ/ГТД KZ/UZ: для таможенного брокера страны импорта.",broker:"Пакет для брокера: перечень документов и контрольные вопросы.",co:"Заявка на CO: экспортер, получатель, маршрут и сведения о товаре.",origin:"Сведения о происхождении: непреференциальное происхождение и производственные основания.",tax:"Расчет платежей: пошлина KZ/UZ, НДС и основания ставок.",check:"Чек-лист комплаенса: контракт, HS, CO, транспорт, банк и налоги."},
  en:{inv:"Commercial invoice: auto-fills contract, parties, goods, value and trade terms.",pkl:"Packing list: goods, packages, gross/net weight and packaging data.",dec:"China export declaration draft: for Single Window pre-entry checks.",ysys:"Declaration elements: name, use, material, specification and brand.",cmr:"CMR waybill: consignor, consignee, loading/unloading points and vehicle.",bro:"KZ/UZ customs declaration data sheet for the import broker.",broker:"Broker instruction pack: document list and control checks.",co:"CO application data: exporter, consignee, route and goods information.",origin:"Origin statement data: non-preferential origin and production basis.",tax:"Import tax estimate: KZ/UZ duty, VAT and rate basis.",check:"Customs compliance checklist: contract, HS, CO, transport, bank and taxes."},
  kk:{inv:"Коммерциялық инвойс: шарт, тараптар, тауар, сома және жеткізу талаптары автоматты толтырылады.",pkl:"Қаптама парағы: тауар, орын саны, брутто/нетто салмақ және қаптама.",dec:"Қытай экспорт декларациясының жобасы: Single Window алдын ала тексеруі үшін.",ysys:"Декларация элементтері: атауы, қолданылуы, материалы, сипаттамасы және бренді.",cmr:"CMR жүкқұжаты: жөнелтуші, алушы, тиеу/түсіру орны және көлік.",bro:"KZ/UZ кеден декларациясы деректері: импорт брокеріне арналған.",broker:"Брокерге тапсырма пакеті: құжаттар тізімі және бақылау тармақтары.",co:"CO өтінім деректері: экспорттаушы, алушы, маршрут және тауар ақпараты.",origin:"Шығу тегі туралы мәлімет: преференциясыз шығу тегі және өндірістік негіз.",tax:"Импорт салық есебі: KZ/UZ бажы, ҚҚС және мөлшерлеме негізі.",check:"Кедендік сәйкестік тізімі: шарт, HS, CO, тасымал, банк және салықтар."}
};
let formTplId="inv";
function formTpl(){return FORM_TPLS.find(t=>t.id===formTplId)||FORM_TPLS[0]}
function drawFormTemplateLibrary(){
  const menu=$("formTplMenu"),detail=$("formTplDetail");if(!menu||!detail)return;
  menu.innerHTML=FORM_TPLS.map(t=>`<div class="contract-choice ${t.id===formTplId?"on":""}" data-form-id="${t.id}"><b>${t.name}</b><span>${t.group} · ${t.desc}</span><small>${t.id===formTplId&&!formTplCollapsed?"点击折叠":"点击打开"}</small></div>`).join("");
  menu.querySelectorAll("[data-form-id]").forEach(el=>el.onclick=e=>{e.preventDefault();e.stopPropagation();selectFormTemplate(el.dataset.formId)});
  const t=formTpl(),meta=DOC_META[t.id]||[t.name,""];
  const body=$("formTplBody");if(body)body.style.display=formTplCollapsed?"none":"block";
  syncTemplateLangSelects();
  $("formTplHint").textContent=t.name;
  $("formTplVerify").innerHTML="🛡 表单模版可单独选择；语言说明按左右栏显示，正式单证仍以目的国/海关要求的语言为准。";
  const selected=!!tplState[t.id]||!!(tplList().find(x=>x.id===t.id)&&tplList().find(x=>x.id===t.id).must);
  const panel=lang=>`<section class="lang-page"><div class="lang-tag">${esc(langName(lang))}</div><h2>${esc(t.name)}</h2><p>${esc((FORM_DESC[lang]&&FORM_DESC[lang][t.id])||t.desc)}</p><table><tr><th>Template</th><td>${esc(meta[0])}</td></tr><tr><th>Code</th><td>${esc(TPL_CODE[t.id]||t.id)}</td></tr><tr><th>Status</th><td>${selected?"Selected":"Optional"}</td></tr></table></section>`;
  detail.innerHTML=`<div style="padding:12px"><div class="bilingual-doc">${panel(formLangLeft)}${panel(formLangRight)}</div></div>`;
}
function selectFormTemplate(id){
  if(id===formTplId)formTplCollapsed=!formTplCollapsed;
  else{formTplId=id;formTplCollapsed=false}
  drawFormTemplateLibrary();
}
function applyFormTemplate(){
  const t=formTpl(),langs=DOC_LANGS[t.id]||["ru"];
  prefLang=langs.includes(formLangRight)?formLangRight:langs.includes(formLangLeft)?formLangLeft:langs[0];
  go("p2");pickDoc(t.id);toast("已打开表单模版："+t.name+" · "+langName(prefLang));
}
function toggleFormTemplate(){
  const t=formTpl(),def=tplList().find(x=>x.id===t.id);
  if(def&&def.must){toast("该表单为当前票型必选模版");return}
  tplState[t.id]=!tplState[t.id];
  drawTpls();drawTabs();drawFormTemplateLibrary();
  toast((tplState[t.id]?"已加入":"已移出")+"当前出单："+t.name);
}

function contractRows(d){
  return `<table><tr><th>货物名称</th><th>HS编码</th><th>数量</th><th>单价</th><th>金额</th></tr>
    <tr><td>${esc(d.goods)}</td><td class="num">${esc(d.hs)}</td><td class="num">${esc(d.qty)}</td><td class="num">${esc(d.price)}</td><td class="num">${fmt((+d.qty||0)*(+d.price||0))}</td></tr></table>`;
}
const hasZh=s=>/[\u4e00-\u9fff]/.test(s||"");
const VALUE_TR={
  place:{cn:"中国 · 新疆",ru:"Китай · Синьцзян",en:"China · Xinjiang",kk:"Қытай · Шыңжаң"},
  port:{cn:"霍尔果斯",ru:"Хоргос",en:"Khorgos",kk:"Қорғас"},
  trans:{cn:"公路卡航（中欧卡车）",ru:"автомобильная перевозка",en:"road freight by truck",kk:"автокөлікпен тасымалдау"},
  pay:{cn:"货到付款",ru:"оплата при доставке",en:"payment on delivery",kk:"жеткізілгеннен кейін төлеу"},
  pkg:{cn:"托盘/打包带固定",ru:"паллеты / фиксация упаковочной лентой",en:"pallets / secured with strapping",kk:"паллет / қаптама таспасымен бекітілген"},
  law:{cn:"中华人民共和国法律",ru:"право Китайской Народной Республики",en:"laws of the People's Republic of China",kk:"Қытай Халық Республикасының құқығы"},
  goods:{cn:"PP集装袋(吨袋) 90×90×110cm 四吊带",ru:"полипропиленовый биг-бэг 90×90×110 см, 4 стропы",en:"PP jumbo bag 90×90×110 cm, four lifting loops",kk:"PP биг-бэг 90×90×110 см, төрт ілмекті"},
  seller:{cn:"新疆立天东大贸易有限公司",ru:"Xinjiang Litian Dongda Trading Co., Ltd.",en:"Xinjiang Litian Dongda Trading Co., Ltd.",kk:"Xinjiang Litian Dongda Trading Co., Ltd."},
  buyer:{cn:"Dongda Ltd.",ru:"Dongda Ltd.",en:"Dongda Ltd.",kk:"Dongda Ltd."},
  seller_addr:{cn:"中国新疆",ru:"Китай, Синьцзян",en:"Xinjiang, China",kk:"Қытай, Шыңжаң"},
  buyer_addr:{cn:"г. Астана, ул. Сауран 3/1, оф.783",ru:"г. Астана, ул. Сауран 3/1, оф.783",en:"Office 783, 3/1 Sauran St., Astana",kk:"Астана қ., Сауран к-сі 3/1, 783-кеңсе"},
  bank:{cn:"开户银行",ru:"банк",en:"bank",kk:"банк"}
};
const CLAUSE_TR={
  quality:{cn:"货物应符合合同约定规格、双方确认样品及出口包装要求。",ru:"Товар должен соответствовать согласованной спецификации, образцам и требованиям экспортной упаковки.",en:"The goods shall conform to the agreed specifications, confirmed samples and export packaging requirements.",kk:"Тауар келісілген сипаттамаға, расталған үлгілерге және экспорттық қаптама талаптарына сәйкес болуы тиіс."},
  pack_clause:{cn:"卖方应采用适合国际运输的包装，保证货物在正常运输、装卸和仓储条件下完好。",ru:"Продавец обязан использовать упаковку, пригодную для международной перевозки, чтобы сохранить товар при обычной перевозке, погрузке и хранении.",en:"The seller shall use packaging suitable for international transport and keep the goods intact under normal transport, handling and storage conditions.",kk:"Сатушы халықаралық тасымалдауға жарамды қаптаманы қолданып, қалыпты тасымалдау, тиеу және сақтау кезінде тауардың сақталуын қамтамасыз етеді."},
  acceptance:{cn:"买方应在收货后合理期限内完成验收；对数量、质量或规格有异议的，应及时提交书面证明。",ru:"Покупатель обязан провести приемку в разумный срок после получения товара; претензии по количеству, качеству или спецификации подаются письменно.",en:"The buyer shall complete acceptance within a reasonable period after receipt; any quantity, quality or specification claim shall be submitted in writing.",kk:"Сатып алушы тауарды алғаннан кейін ақылға қонымды мерзімде қабылдауды аяқтайды; саны, сапасы немесе сипаттамасы бойынша талап жазбаша беріледі."},
  breach:{cn:"任一方违反本合同约定，应赔偿守约方因此遭受的直接损失；因不可抗力导致不能履约的，受影响方应及时通知并提供证明。",ru:"Сторона, нарушившая договор, возмещает другой стороне прямые убытки; при форс-мажоре затронутая сторона своевременно уведомляет другую сторону и предоставляет подтверждение.",en:"A breaching party shall compensate the non-breaching party for direct losses; in case of force majeure, the affected party shall promptly notify the other party and provide evidence.",kk:"Шартты бұзған тарап екінші тараптың тікелей шығындарын өтейді; форс-мажор кезінде зардап шеккен тарап дер кезінде хабарлап, дәлел ұсынады."},
  dispute:{cn:"协商不成，提交卖方所在地有管辖权人民法院诉讼解决。",ru:"При недостижении соглашения спор передается в компетентный суд по месту нахождения продавца.",en:"If negotiation fails, the dispute shall be submitted to the competent court at the seller's location.",kk:"Келіссөз нәтиже бермесе, дау сатушы орналасқан жердегі құзыретті сотқа беріледі."},
  delivery:{cn:"按双方确认计划执行",ru:"в соответствии с согласованным графиком",en:"according to the schedule confirmed by both parties",kk:"тараптар келіскен кестеге сәйкес"}
};
function trValue(key,val,lang){
  if(lang==="cn")return val||VALUE_TR[key]?.cn||"—";
  if(!val||val==="—")return "—";
  if(VALUE_TR[key]&&hasZh(val))return VALUE_TR[key][lang]||VALUE_TR[key].en||val;
  if(key==="port"&&VALUE_TR.port&&hasZh(val))return VALUE_TR.port[lang]||val;
  if(key==="trans"&&hasZh(val))return VALUE_TR.trans[lang]||val;
  if(key==="pay"&&hasZh(val))return VALUE_TR.pay[lang]||val;
  if(key==="pkg"&&hasZh(val))return VALUE_TR.pkg[lang]||val;
  if(key==="law"&&hasZh(val))return VALUE_TR.law[lang]||val;
  if(key==="bank"&&hasZh(val))return VALUE_TR.bank[lang]||"bank";
  return val;
}
function trClause(key,val,lang){
  if(lang==="cn")return val||CLAUSE_TR[key]?.cn||"";
  return (!val||hasZh(val))?(CLAUSE_TR[key]?.[lang]||CLAUSE_TR[key]?.en||val):val;
}
const PENDING_TR={ru:"наименование требует перевода",en:"name pending translation",kk:"атауы аударуды қажет етеді"};
function lineNameByLang(it,lang){
  if(lang==="cn")return it.name||it.nameRu||"—";
  if(it.nameRu)return it.nameRu;
  if(!hasZh(it.name||""))return it.name||"—";
  return PENDING_TR[lang]||PENDING_TR.en;
}
function lineSpecByLang(it,lang){
  const s=[it.spec,it.elements].filter(Boolean).join("; ");
  if(lang==="cn")return s;
  return hasZh(s)?(lang==="ru"?"характеристики требуют перевода":lang==="kk"?"сипаттамалар аударуды қажет етеді":"parameters pending translation"):s;
}
function contractGoodsRows(lines,lang,m,cur){
  return lines.map((it,i)=>{
    const amt=(+it.qty||0)*(+it.price||0),spec=lineSpecByLang(it,lang);
    return `<tr><td>${i+1}</td><td>${esc(lineNameByLang(it,lang))}${spec?`<br><small>${esc(spec)}</small>`:""}</td><td class="num">${esc(it.hs)}</td><td class="num">${esc(it.qty)} ${esc(it.unit||"")}</td><td class="num">${fmt(it.price)}</td><td class="num">${fmt(amt)}</td></tr>`;
  }).join("");
}
function contractPanelHtml(d,t,lang){
  const m=ML[lang]||ML.cn,lines=contractLineData(),amount=lines.reduce((s,it)=>s+(+it.qty||0)*(+it.price||0),0),title=t.id==="purchase"?m.purchase:m.sale;
  const dest=d.country==="UZ"?(lang==="cn"?"乌兹别克斯坦":lang==="ru"?"Узбекистан":lang==="kk"?"Өзбекстан":"Uzbekistan"):(lang==="cn"?"哈萨克斯坦":lang==="ru"?"Казахстан":lang==="kk"?"Қазақстан":"Kazakhstan");
  const v={place:trValue("place",d.place,lang),seller:trValue("seller",d.seller,lang),seller_addr:trValue("seller_addr",d.seller_addr,lang),seller_bank:trValue("bank",d.seller_bank,lang),buyer:trValue("buyer",d.buyer,lang),buyer_addr:trValue("buyer_addr",d.buyer_addr,lang),buyer_bank:trValue("bank",d.buyer_bank,lang),goods:trValue("goods",d.goods,lang),pkg:trValue("pkg",d.pkg,lang),port:trValue("port",d.port,lang),trans:trValue("trans",d.trans,lang),pay:trValue("pay",d.pay,lang),law:trValue("law",d.law,lang),delivery:trClause("delivery",d.delivery,lang),quality:trClause("quality",d.quality,lang),pack_clause:trClause("pack_clause",d.pack_clause,lang),acceptance:trClause("acceptance",d.acceptance,lang),breach:trClause("breach",d.breach,lang),dispute:trClause("dispute",d.dispute,lang)};
  return `<section class="lang-page"><div class="lang-tag">${esc(m.name)}</div><h2>${esc(title)}</h2><p style="text-align:center">${esc(m.sub)}</p>
    <table><tr><th>${m.no}</th><td>${esc(d.contract||"—")}</td><th>${m.date}</th><td>${esc(d.date||today())}</td></tr><tr><th>${m.place}</th><td colspan="3">${esc(v.place||"")}</td></tr></table>
    <table><tr><th>${m.seller}</th><td>${esc(v.seller)}</td></tr><tr><th>${m.addr}</th><td>${esc(v.seller_addr||"—")}</td></tr><tr><th>${m.tax}</th><td>${esc(d.seller_tax||"—")}</td></tr><tr><th>${m.bank}</th><td>${esc(v.seller_bank||"—")}</td></tr><tr><th>${m.swift}</th><td>${esc(d.seller_swift||"—")}</td></tr><tr><th>${m.account}</th><td>${esc(d.seller_account||"—")}</td></tr></table>
    <table><tr><th>${m.buyer}</th><td>${esc(v.buyer)}</td></tr><tr><th>${m.addr}</th><td>${esc(v.buyer_addr||"—")}</td></tr><tr><th>${m.tax}</th><td>${esc(d.buyer_tax||"—")}</td></tr><tr><th>${m.bank}</th><td>${esc(v.buyer_bank||"—")}</td></tr><tr><th>${m.account}</th><td>${esc(d.buyer_iban||"—")}</td></tr><tr><th>${m.bik}</th><td>${esc(d.buyer_bik||"—")}</td></tr></table>
    <h3>${m.goods}</h3><p>${esc(m.goodsText)}</p><table class="contract-goods"><colgroup><col style="width:7%"><col style="width:32%"><col style="width:15%"><col style="width:13%"><col style="width:14%"><col style="width:19%"></colgroup><tr><th>№</th><th>${m.item}</th><th>${m.hs}</th><th>${m.qty}</th><th>${m.price}</th><th>${m.amount}</th></tr>
    ${contractGoodsRows(lines,lang,m,d.cur)}
    <tr><td colspan="5" style="text-align:right"><b>${m.total}</b></td><td class="num"><b>${fmt(amount)}</b></td></tr></table>
    <table><tr><th>${m.total}</th><td><b>${esc(d.cur)} ${fmt(amount)}</b></td></tr><tr><th>${m.country}</th><td>${esc(dest)}</td></tr><tr><th>${m.pkg}</th><td>${esc(v.pkg||"—")}</td></tr><tr><th>${m.weight}</th><td>${esc(d.gw||"—")} kg / ${esc(d.nw||"—")} kg</td></tr></table>
    <h3>${m.quality}</h3><p>${esc(v.quality)}</p>
    <h3>${m.pack}</h3><p>${esc(v.pack_clause)}</p>
    <h3>${m.delivery}</h3><p>${esc(d.terms)} · ${esc(v.port||"")} · ${esc(v.trans||"")} · ${esc(v.delivery)}</p>
    <h3>${m.payment}</h3><p>${esc(v.pay||"—")}</p>
    <h3>${m.acceptance}</h3><p>${esc(v.acceptance)}</p>
    <h3>${m.breach}</h3><p>${esc(v.breach)}</p>
    <h3>${m.law}</h3><p>${esc(v.law)} · ${esc(v.dispute)}</p>
    <h3>${m.effective}</h3><p>${esc(m.effectiveText)}</p>
    <div class="row2" style="margin-top:14px"><span><b>${m.sellerSeal}</b><br><br>__________________</span><span><b>${m.buyerSeal}</b><br><br>__________________</span></div></section>`;
}
function contractDocHtml(){
  const t=contractTpl(),d=contractParamData();
  const no=d.contract||"—";
  return `<div class="doc contract-doc">${docBrand()}<h1>Dongda Contract File</h1><div class="sub">${langName(contractLangLeft)} / ${langName(contractLangRight)} · ${t.id==="purchase"?"Purchase":"Sales"} · No. ${esc(no)} · ${esc(d.date||today())}</div>
    <div class="bilingual-doc">${contractPanelHtml(d,t,contractLangLeft)}${contractPanelHtml(d,t,contractLangRight)}</div>${seal()}<div class="foot">CONTRACT-${t.id.toUpperCase()} · ${today()} · ${esc(no)}</div></div>`;
}
function previewContractTemplate(showToast=true){
  const p=$("contractPreview");if(!p)return;
  p.innerHTML=contractDocHtml();
  if(showToast)toast("合同预览已生成");
}
function exportContractTemplate(){
  const html=contractDocHtml(),t=contractTpl();
  recordGeneratedDoc({kind:"contract",docId:t.id,title:t.name,action:"导出合同PDF",html});
  $("printArea").innerHTML=html;
  setTimeout(()=>window.print(),100);
}

/* ================= 渲染联动 ================= */
function render(){
  const t=total(),R=loadRates();
  const kz=taxTotals("KZ"),uz=taxTotals("UZ"),kzD=kz.duty,kzV=kz.vat,uzD=uz.duty,uzV=uz.vat;
  const cur=$("f_cur").value;
  $("kz_head").textContent="哈萨克斯坦（关税"+[...kz.rates].join("/")+" · НДС "+R.kz.vat+"%）";
  $("uz_head").textContent="乌兹别克斯坦（关税需10位码核验 · НДС "+R.uz.vat+"%）";
  $("kz_duty_l").textContent="进口关税 "+[...kz.rates].join("/");$("kz_vat_l").textContent="增值税 НДС "+R.kz.vat+"%";
  $("uz_duty_l").textContent="进口关税 测算";$("uz_vat_l").textContent="增值税 НДС "+R.uz.vat+"%";
  $("kz_basis").innerHTML="依据："+R.kz.dutyBasis+"；"+R.kz.vatBasis;
  $("uz_basis").innerHTML="依据："+R.uz.dutyBasis+"；"+R.uz.vatBasis;
  $("rateStamp").textContent=(rateStale()?"⚠ 税率核验已超60天":"🛡 税率核验 "+R.checked);
  $("kz_cif").textContent=cur+" "+fmt(t);$("kz_duty").textContent=cur+" "+fmt(kzD);$("kz_vat").textContent=cur+" "+fmt(kzV);$("kz_total").textContent=cur+" "+fmt(kzD+kzV);
  $("uz_cif").textContent=cur+" "+fmt(t);$("uz_duty").textContent=cur+" "+fmt(uzD);$("uz_vat").textContent=cur+" "+fmt(uzV);$("uz_total").textContent=cur+" "+fmt(uzD+uzV);
  if(curTicket){$("curNo").textContent=curTicket.no;$("curNo2").textContent=curTicket.no}
  drawTpls();drawContractTemplates();drawFormTemplateLibrary();drawTabs();drawDoc();
}

/* ================= 合同识别（多层验证） ================= */
let upFiles=[],lastExtract=null,lastVerify=null;
function onUpload(inp){
  upFiles=[...inp.files];
  $("upTitle").textContent=upFiles.length?("已选择："+upFiles.map(f=>f.name).join("、")):"点击上传合同（可多页/多文件）";
  $("btnRecog").disabled=!upFiles.length;
}
function fileToB64(f){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result.split(",")[1]);r.onerror=no;r.readAsDataURL(f)})}
function recogUI(start){$("recogCard").style.display="block";$("resultCard").style.display="none";$("recogSteps").innerHTML="";$("pfill").style.width="0"}
function stepDone(msg,err){$("recogSteps").insertAdjacentHTML("beforeend",`<div class="${err?"err":"done"}">${err?"✗":"✓"} ${msg}</div>`)}
async function startRecognize(){
  if(!upFiles.length)return;
  recogUI();
  const steps=["读取合同文件…","层1 通道A · Claude提取员识别…","层1 通道B · 独立稽核员复核…","层2 字段交叉比对（逐字符）…","层3 规则引擎：金额连乘/IBAN mod-97/SWIFT/HS/日期…","层4 置信度融合评级…"];
  let i=0;const tick=setInterval(()=>{if(i<steps.length-1){stepDone(steps[i]);$("pfill").style.width=((i+1)/steps.length*90)+"%";i++}},900);
  try{
    const files=[];
    for(const f of upFiles)files.push({name:f.name,size:f.size,media_type:f.type||"application/pdf",data:await fileToB64(f)});
    cloudArchiveFiles(files,"recognize",curTicket&&curTicket.no);
    const r=await fetch(apiBase()+"/api/recognize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files,category:"recognize",ticket_no:curTicket&&curTicket.no})});
    const data=await r.json();
    clearInterval(tick);
    if(!r.ok||!data.ok){stepDone(data.error||"识别失败",true);return}
    while(i<steps.length){stepDone(steps[i]);i++}
    $("pfill").style.width="100%";
    showResult(data.result,data.verification);
  }catch(e){clearInterval(tick);stepDone("网络错误："+e.message,true)}
}
function resetRecognize(){upFiles=[];$("upfile").value="";onUpload($("upfile"));$("recogCard").style.display="none";$("resultCard").style.display="none"}

/* 演示数据 = 真实合同 DXH-20260603 */
const DEMO={result:{ticket_type:"import",contract_no:"DXH-20260603-02",contract_no_alt:"DXH-20260603-01",sign_date:"2026-06-03",
  seller:{name:"阿克苏兴华进出口贸易有限公司",name_lat:"Aksu Xinghua Import and Export Trade Co., Ltd",bank:"中国银行新疆阿克苏地区分行",bank_lat:"BANK OF CHINA, Xinjiang Aksu Branch",swift:"BKCHCNBJ760",account:"107106450600",tax_id:"91652900MAE7897NXT"},
  buyer:{name:"Частная компания Dongda Ltd.",address:"г. Астана, ул. Сауран 3/1, оф.783",bank:"АО «Банк ЦентрКредит»",iban:"KZ198562203148814317",bik:"KCJBKZKX",bin:"250840901034",tel:"7 707 5590188"},
  destination_country:"KZ",currency:"CNY",
  goods:[{name:"聚丙烯织物袋（吨袋）",name_ru:"Полипропиленовые тканые мешки (Биг-бэги)",spec:"80*80*140，10%母粒基布全新料内膜≥2.1kg",spec_ru:"80*80*140, 10% суперконцентрат, новый материал с вкладышем ≥2,1 кг",hs:"6305390000",qty:700,unit:"条",price:33,amount:23100}],
  total:23100,total_words:"人民币贰万叁仟壹佰元整",terms:"",payment:"货到付款",delivery_date:"2026-07-15",
  confidence:{contract_no:99,seller:98,buyer:98,goods:97,total:99,terms:0,payment:96}},
 verification:{channels:2,
  consistency:[{field:"contract_no",match:true},{field:"total",match:true},{field:"goods_qty",match:true},{field:"goods_price",match:true},{field:"seller",match:true},{field:"buyer",match:true},{field:"iban",match:true},{field:"terms",match:true}],
  rules:[
   {rule:"金额连乘",pass:true,msg:"700 × ¥33.00 = ¥23,100.00 与行金额一致",level:"mid"},
   {rule:"合计校验",pass:true,msg:"明细合计与合同总额 ¥23,100 一致，与大写金额一致",level:"mid"},
   {rule:"版本比对",pass:false,msg:"中文版合同号 DXH-20260603-02 与俄文版 DXH-20260603-01 不一致",level:"high"},
   {rule:"条款完整性",pass:false,msg:"贸易条款为占位符 [此处填写贸易术语]，无法出CMR/申报",level:"high"},
   {rule:"HS编码",pass:false,msg:"货物为吨袋(Биг-бэги)，建议核对 6305.32（合同为 6305390000）",level:"mid"},
   {rule:"IBAN校验位",pass:true,msg:"买方IBAN KZ19…4317 mod-97 校验通过",level:"mid"},
   {rule:"SWIFT格式",pass:true,msg:"卖方SWIFT BKCHCNBJ760 格式正确",level:"mid"}],
  fieldStatus:{contract_no:"block",seller:"ok",buyer:"ok",goods:"check",total:"ok",terms:"block",payment:"ok"}}};
function demoRecognize(){
  recogUI();
  const steps=["读取合同文件（4页扫描件）…","层1 通道A · Claude提取员识别…","层1 通道B · 独立稽核员复核…","层2 字段交叉比对：8/8 字段一致 ✓","层3 规则引擎：金额✓ IBAN✓ SWIFT✓ · 合同号✗ 条款✗ HS⚠","层4 置信度融合：2 项阻断 · 1 项核对"];
  let i=0;const tick=setInterval(()=>{
    if(i<steps.length){stepDone(steps[i]);$("pfill").style.width=((i+1)/steps.length*100)+"%";i++}
    else{clearInterval(tick);showResult(DEMO.result,DEMO.verification)}
  },480);
}

const ST_BADGE={ok:'<span class="conf c-hi">通过</span>',check:'<span class="conf c-lo">核对</span>',block:'<span class="conf c-lo" style="background:#F9E3E0;color:#C0392B">阻断</span>'};
function showResult(res,ver){
  lastExtract=res;lastVerify=ver;
  $("resultTitle").textContent="识别结果 · "+(res.ticket_type==="import"?"进口采购票":"出口票")+"（双通道 "+(ver&&ver.channels===2?"已交叉比对":"单通道")+"）";
  const fs=(ver&&ver.fieldStatus)||{};
  const rows=[];
  const row=(f,label,val)=>rows.push(`<tr class="${fs[f]&&fs[f]!=="ok"?"lowconf":""}"><td>${label}</td><td>${val}</td><td>${ST_BADGE[fs[f]||"ok"]}</td></tr>`);
  row("contract_no","合同号",esc(res.contract_no)+(res.contract_no_alt&&res.contract_no_alt!==res.contract_no?` / 外文版 ${esc(res.contract_no_alt)} <i>⚠ 不一致</i>`:""));
  row("seller","卖方",esc(res.seller.name)+(res.seller.swift?" · SWIFT "+esc(res.seller.swift):""));
  row("buyer","买方",esc(res.buyer.name)+(res.buyer.iban?" · IBAN "+esc(res.buyer.iban):""));
  row("goods","货物",(res.goods||[]).map(g=>`${esc(g.name)} ${esc(g.spec)} ×${(+g.qty).toLocaleString()} @ ${fmt(g.price)} (HS ${esc(g.hs)})`).join("<br>"));
  row("total","总额",res.currency+" "+fmt(res.total)+(res.total_words?"（大写一致 ✓）":""));
  row("terms","贸易条款",res.terms?esc(res.terms):'<i>⚠ 合同留空，必须补充</i>');
  row("payment","付款 / 交货期",esc(res.payment)+" / "+esc(res.delivery_date));
  $("resultBody").innerHTML=rows.join("");
  const rl=(ver&&ver.rules)||[];
  $("warnList").innerHTML=rl.length?`<div style="font-weight:800;font-size:13px;margin-bottom:7px">层3 规则引擎结果</div>`+rl.map(r=>
    `<div style="font-size:12.5px;font-weight:600;padding:6px 10px;border-radius:8px;margin-bottom:5px;background:${r.pass?"#F2F8F4":r.level==="high"?"#FBEBE8":"#FBF3DF"};color:${r.pass?"var(--ok)":r.level==="high"?"#B03A2E":"#9A6E12"}">${r.pass?"✓":"✗"} 【${r.rule}】${esc(r.msg)}</div>`).join(""):"";
  $("resultCard").style.display="block";
  $("resultCard").scrollIntoView({behavior:"smooth"});
}
function applyExtract(){
  if(!lastExtract)return;
  const res=lastExtract,fs=(lastVerify&&lastVerify.fieldStatus)||{};
  newTicket(res.ticket_type==="import"?"import":"export");
  curTicket.sellerInfo={name:res.seller.name,lat:res.seller.name_lat,bank:res.seller.bank,bankLat:res.seller.bank_lat,swift:res.seller.swift,account:res.seller.account,tax:res.seller.tax_id};
  curTicket.buyerInfo={name:res.buyer.name,addr:res.buyer.address,bank:res.buyer.bank,iban:res.buyer.iban,bik:res.buyer.bik,bin:res.buyer.bin};
  curTicket.warnings=((lastVerify&&lastVerify.rules)||[]).filter(r=>!r.pass);
  $("f_type").value=res.ticket_type==="import"?"import":"export";
  $("f_seller").value=res.seller.name||"";$("f_buyer").value=res.buyer.name||"";
  if(res.destination_country==="UZ")$("f_country").value="UZ";else $("f_country").value="KZ";
  $("f_contract").value=res.contract_no||"";
  $("f_cur").value=["USD","CNY","RUB","EUR"].includes(res.currency)?res.currency:"USD";
  if(res.terms)setSelectOrAdd($("f_terms"),res.terms);
  $("f_pay").value=res.payment||"";
  items=(res.goods||[]).map(g=>{
    const specRu=g.spec_ru||(g.spec&&!hasCJK(g.spec)?g.spec:"");
    return{name:(g.name||"")+(g.spec?" "+g.spec:""),nameRu:(g.name_ru||"")+(specRu?" "+specRu:""),hs:normHs(g.hs),qty:+g.qty||0,price:+g.price||0}});
  if(!items.length)items=[{name:"",hs:"6305.33",qty:0,price:0}];
  drawItems();render();go("p1");
  const blocks=Object.keys(fs).filter(k=>fs[k]==="block");
  toast(blocks.length?("已带入 ✓ 注意："+blocks.length+" 个阻断字段（"+blocks.join("、")+"）必须修正后才能出单证"):"识别数据已带入 ✓ 请补充运输信息");
}
function normHs(h){const d=String(h||"").replace(/\D/g,"");return d.length>=6?d.slice(0,4)+"."+d.slice(4,6):(h||"6305.33")}
function setSelectOrAdd(sel,val){
  if(!sel||!val)return;
  if(![...sel.options].some(o=>o.value===val||o.text===val)){const o=document.createElement("option");o.text=val;sel.add(o)}
  sel.value=val;
}

/* ================= 单证引擎（语言按使用方锁定，术语=当地海关官方用语） =================
   俄文单证(inv/pkl/cmr/bro)：纯俄文，ДТ按ЕАЭС официальные графы；屏幕灰字中文对照(.cnh)打印自动去除
   中文单证(dec/ysys/co)：纯中文，按《填制规范》官方栏目用语 */
const DOC_META={inv:["商业发票","Инвойс · 俄文"],pkl:["装箱单","Упаковочный лист · 俄文"],dec:["出口报关单草单","中国海关 · 中文"],ysys:["申报要素表","中国海关 · 中文"],cmr:["CMR 运输单","КДПГ · 俄文"],bro:["申报资料表","ДТ/ГТД · 俄文"],co:["原产地证申请","CO · 中文"],origin:["原产地声明","CO辅助 · 中文"],tax:["税费测算表","KZ/UZ · 中文"],check:["合规清单","三国核验"],broker:["代理委托资料","Broker · 俄文"]};
function drawTabs(){
  const tabs=$("docTabs");if(!tabs)return;
  const list=selectedTpls().map(t=>t.id);
  if(!list.includes(curDoc))curDoc=list[0]||"inv";
  tabs.innerHTML=list.map(id=>`<div class="chip ${id===curDoc?"active":""}" onclick="pickDoc('${id}')">${DOC_META[id][0]}<small>${DOC_META[id][1]}</small></div>`).join("");
}
function pickDoc(d){curDoc=d;drawTabs();syncLangSel();drawDoc()}
/* 单证语言：inv/pkl 可选 ru/en/cn；cmr/bro 锁俄文(官方)；dec/ysys/co 锁中文(官方) */
const DOC_LANGS={inv:["ru","en","cn","kk"],pkl:["ru","en","cn","kk"],cmr:["ru"],bro:["ru"],broker:["ru"],dec:["cn"],ysys:["cn"],co:["cn"],origin:["cn"],tax:["cn"],check:["cn"]};
let docLang="ru",prefLang="ru"; // prefLang=用户偏好，docLang=当前单证生效语言
const L={
 ru:{inv:"КОММЕРЧЕСКИЙ ИНВОЙС",inv2:"COMMERCIAL INVOICE",pkl:"УПАКОВОЧНЫЙ ЛИСТ",pkl2:"PACKING LIST",seller:"Продавец",buyer:"Покупатель",bank:"Банк",terms:"Условия поставки",pay:"Условия оплаты",cur:"Валюта",name:"Наименование товара",hs:"Код ТН ВЭД",qty:"Кол-во",unit:"Ед.",unitv:"шт.",price:"Цена",amount:"Сумма",total:"ИТОГО",gross:"Вес брутто",net:"Вес нетто",places:"Кол-во мест",kg:"кг",veh:"Транспортное средство",port:"Пункт пропуска",contract:"Контракт №",date:"Дата",invno:"Инвойс №"},
 en:{inv:"COMMERCIAL INVOICE",inv2:"",pkl:"PACKING LIST",pkl2:"",seller:"Seller",buyer:"Buyer",bank:"Bank",terms:"Delivery terms",pay:"Payment terms",cur:"Currency",name:"Description of goods",hs:"HS Code",qty:"Quantity",unit:"Unit",unitv:"pcs",price:"Unit price",amount:"Amount",total:"TOTAL",gross:"Gross weight",net:"Net weight",places:"Packages",kg:"kg",veh:"Vehicle",port:"Border crossing",contract:"Contract No.",date:"Date",invno:"Invoice No."},
 cn:{inv:"商 业 发 票",inv2:"COMMERCIAL INVOICE",pkl:"装 箱 单",pkl2:"PACKING LIST",seller:"卖方",buyer:"买方",bank:"开户行",terms:"贸易条款",pay:"付款方式",cur:"币种",name:"商品名称及规格",hs:"HS编码",qty:"数量",unit:"单位",unitv:"条",price:"单价",amount:"金额",total:"合 计",gross:"毛重",net:"净重",places:"件数",kg:"千克",veh:"运输车辆",port:"出境口岸",contract:"合同号",date:"日期",invno:"发票号"},
 kk:{inv:"КОММЕРЦИЯЛЫҚ ИНВОЙС",inv2:"COMMERCIAL INVOICE",pkl:"ҚАПТАМА ПАРАҒЫ",pkl2:"PACKING LIST",seller:"Сатушы",buyer:"Сатып алушы",bank:"Банк",terms:"Жеткізу талаптары",pay:"Төлем талаптары",cur:"Валюта",name:"Тауар сипаттамасы",hs:"HS / ТН ВЭД коды",qty:"Саны",unit:"Өлш.",unitv:"дана",price:"Бірлік бағасы",amount:"Сома",total:"БАРЛЫҒЫ",gross:"Брутто салмақ",net:"Нетто салмақ",places:"Орын саны",kg:"кг",veh:"Көлік құралы",port:"Шекара өткізу пункті",contract:"Шарт №",date:"Күні",invno:"Инвойс №"}
};
function setDocLang(v){prefLang=v;drawDoc()}
const PAY_TR={
 ru:[["货到付款","оплата при доставке"],["预付","предоплата"],["发货前","до отгрузки"],["发货后","после отгрузки"],["见提单副本","против копии коносамента"],["账期","отсрочка платежа"],["天","дней"],["信用证","аккредитив (L/C)"]],
 en:[["货到付款","payment on delivery"],["预付","advance payment"],["发货前","before shipment"],["发货后","after shipment"],["见提单副本","against copy of B/L"],["账期","net terms"],["天","days"],["信用证","L/C"]]};
const hasCJK=s=>/[\u4e00-\u9fff]/.test(s||"");
const BANK_TR=[["中国银行","BANK OF CHINA"],["中国工商银行","ICBC"],["中国建设银行","CHINA CONSTRUCTION BANK"],["中国农业银行","AGRICULTURAL BANK OF CHINA"],["交通银行","BANK OF COMMUNICATIONS"],["新疆","Xinjiang "],["阿克苏","Aksu "],["乌鲁木齐","Urumqi "],["地区分行","Branch"],["分行","Branch"],["支行","Sub-branch"]];
function trBank(s){if(!s||!hasCJK(s))return s;let r=s;BANK_TR.forEach(([a,b])=>r=r.split(a).join(b));
  r=r.replace(/[\u4e00-\u9fff]+/g,"").replace(/\s+/g," ").trim();return r||"Bank (see SWIFT)"}
function trPay(s){if(docLang==="cn"||!s)return s;let r=s;(PAY_TR[docLang]||[]).forEach(([a,b])=>r=r.split(a).join(b));return r}
function gName(it){return docLang==="cn"?it.name:(it.nameRu&&it.nameRu.trim()?it.nameRu:it.name)}
function syncLangSel(){const s=$("docLangSel"),h=$("docLangHint");if(!s)return;
  const langs=DOC_LANGS[curDoc]||["ru"];
  docLang=langs.includes(prefLang)?prefLang:langs[0];
  s.value=docLang;s.disabled=langs.length===1;
  h.textContent=langs.length===1?(langs[0]==="ru"?"🔒 本单证为当地海关/报关代理使用格式，语言固定：俄文":"🔒 本单证为中文核对/申报辅助格式，语言固定：中文"):"";}
function cn(s){return `<span class="cnh">${s}</span>`} // 中文对照·仅屏显
function ruName(it){return it.nameRu&&it.nameRu.trim()?it.nameRu:it.name} // 俄文单证优先俄文品名
function seal(){
  if(sealMode==="none")return "";
  return `<div class="seal-area pos-${sealPosition}"><div class="seal-box"><div class="seal"><img src="brand/dongda-seal.png?v=20260613-6" alt="Dongda Ltd official seal"></div><div class="seal-line">Dongda Ltd.</div><div class="seal-meta">Подпись / печать<br>Signature / company seal</div></div></div>`;
}
function docBrand(){
  const c=loadCompany();
  return `<div class="doc-brand"><img src="brand/dongda-logo-header.jpg?v=20260613-6" alt="Litian Dongda Ltd logo"><div class="brand-copy"><b>Litian Dongda Ltd · Dongda Ltd.</b><span>Customs & Trade Documents · Dongda Controlled File</span><small>${esc(c.im.addr)}<br>Тел. ${esc(c.im.tel||DEF_COMPANY.im.tel)}</small></div></div>`;
}
const TPL_CODE={inv:"INV-v3",pkl:"PKL-v3",dec:"CN-DEC (GAC spec, current)",ysys:"CN-ELEM",cmr:"CMR (CMR Convention)",bro:"EAEU-DT №257 / UZ T-6",co:"CO-v2",origin:"ORIGIN-v1",tax:"TAX-"+RATE_VERSION,check:"COMPLIANCE-"+RATE_VERSION,broker:"BROKER-v1"};
function docFoot(id){return `<div class="foot">TPL ${TPL_CODE[id]||id} · ${today()} · ${curTicket?curTicket.no:""}</div>`}
function gv(){return{t:total(),seller:$("f_seller").value,buyer:$("f_buyer").value,contract:$("f_contract").value,terms:$("f_terms").value,
  cur:$("f_cur").value,gw:$("f_gw").value||"—",nw:$("f_nw").value||"—",pkg:$("f_pkg").value||"—",truck:$("f_truck").value||"—",
  port:$("f_port").value,date:$("f_date").value||today(),pay:$("f_pay").value,country:$("f_country").value,
  si:curTicket?curTicket.sellerInfo||{}:{},bi:curTicket?curTicket.buyerInfo||{}:{},no:curTicket?curTicket.no:"—"}}
const PORT_RU={"霍尔果斯":"Хоргос","阿拉山口":"Алашанькоу","巴克图":"Бакту","伊尔克什坦":"Иркештам"};
const TRANS_RU={"公路卡航（中欧卡车）":"автомобильный","铁路集装箱":"железнодорожный","公铁联运":"мультимодальный"};
function rowsRu(){return items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(ruName(it))}${it.nameRu?cn(" "+it.name):""}</td><td class="num">${esc(it.hs)}</td><td class="num">${(+it.qty).toLocaleString()}</td><td>шт.</td><td class="num">${fmt(it.price)}</td><td class="num">${fmt(it.qty*it.price)}</td></tr>`).join("")}
function docHtml(id){
  const v=gv();const portRu=portRuOf(v.port);
  const headRu=`<div class="meta"><span>Контракт № ${esc(v.contract)}</span><span>Дата: ${v.date}</span><span>Инвойс № ${v.no}</span></div>`;
  const tblRu=`<table><tr><th>№</th><th>Наименование товара ${cn("品名")}</th><th>Код ТН ВЭД ${cn("HS")}</th><th>Кол-во ${cn("数量")}</th><th>Ед.</th><th>Цена ${cn("单价")}</th><th>Сумма, ${v.cur}</th></tr>${rowsRu()}
   <tr><td colspan="6" style="text-align:right"><b>ИТОГО ${cn("合计")}</b></td><td class="num"><b>${fmt(v.t)}</b></td></tr></table>`;
  const D={};
  /* ---- 俄文单证 ---- */
  const T=L[DOC_LANGS[id]&&DOC_LANGS[id].includes(docLang)?docLang:(DOC_LANGS[id]||["ru"])[0]];
  const hint=s=>(docLang==="ru"&&(id==="inv"||id==="pkl"))?cn(s):"";
  const headT=`<div class="meta"><span>${T.contract} ${esc(v.contract)}</span><span>${T.date}: ${v.date}</span><span>${T.invno} ${v.no}</span></div>`;
  const tblT=`<table><tr><th>№</th><th>${T.name} ${hint("品名")}</th><th>${T.hs}</th><th>${T.qty}</th><th>${T.unit}</th><th>${T.price}</th><th>${T.amount}, ${v.cur}</th></tr>
   ${items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(gName(it))}${docLang==="ru"&&it.nameRu?cn(" "+it.name):""}</td><td class="num">${esc(it.hs)}</td><td class="num">${(+it.qty).toLocaleString()}</td><td>${T.unitv}</td><td class="num">${fmt(it.price)}</td><td class="num">${fmt(it.qty*it.price)}</td></tr>`).join("")}
   <tr><td colspan="6" style="text-align:right"><b>${T.total}</b></td><td class="num"><b>${fmt(v.t)}</b></td></tr></table>`;
  D.inv=`<div class="doc">${docBrand()}<h1>${T.inv}</h1><div class="sub">${T.inv2} ${hint("商业发票")}</div>${headT}
    <div class="row2"><div><b>${T.seller} ${hint("卖方")}:</b><br>${esc(docLang==="cn"?v.seller:(v.si.lat||v.seller))}${docLang==="ru"&&v.si.lat?cn("<br>"+v.seller):""}${v.si.bank?"<br>"+T.bank+": "+esc(docLang==="cn"?v.si.bank:(v.si.bankLat||trBank(v.si.bank)))+(v.si.swift?", SWIFT: "+esc(v.si.swift):""):""}</div>
    <div><b>${T.buyer} ${hint("买方")}:</b><br>${esc(v.buyer)}${v.bi.addr?"<br>"+esc(v.bi.addr):""}${v.bi.iban?"<br>IBAN: "+esc(v.bi.iban):""}</div></div><br>
    <div class="row2"><span><b>${T.terms}:</b> ${esc(v.terms)}</span><span><b>${T.pay}:</b> ${esc(trPay(v.pay))}</span><span><b>${T.cur}:</b> ${v.cur}</span></div>${tblT}
    <div class="row2"><span>${T.gross} ${hint("毛重")}: ${esc(v.gw)} ${T.kg}</span><span>${T.net} ${hint("净重")}: ${esc(v.nw)} ${T.kg}</span><span>${T.places} ${hint("件数")}: ${esc(v.pkg)}</span></div>${seal()}${docFoot(id)}</div>`;
  D.pkl=`<div class="doc">${docBrand()}<h1>${T.pkl}</h1><div class="sub">${T.pkl2} ${hint("装箱单")}</div>${headT}
    <table><tr><th>№</th><th>${T.name} ${hint("品名")}</th><th>${T.hs}</th><th>${T.qty}, ${T.unitv}</th><th>${T.gross}, ${T.kg}</th><th>${T.net}, ${T.kg}</th></tr>
    ${items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(gName(it))}${docLang==="ru"&&it.nameRu?cn(" "+it.name):""}</td><td class="num">${esc(it.hs)}</td><td class="num">${(+it.qty).toLocaleString()}</td><td class="num">${i===0?esc(v.gw):"—"}</td><td class="num">${i===0?esc(v.nw):"—"}</td></tr>`).join("")}
    <tr><td colspan="3" style="text-align:right"><b>${T.total}</b></td><td class="num"><b>${esc(v.pkg)}</b></td><td class="num"><b>${esc(v.gw)}</b></td><td class="num"><b>${esc(v.nw)}</b></td></tr></table>
    <p style="font-size:12px">${T.veh} ${hint("车辆")}: ${esc(v.truck)}　${T.port} ${hint("口岸")}: ${docLang==="cn"?esc(v.port):portRu}</p>${seal()}${docFoot(id)}</div>`;
  D.cmr=`<div class="doc">${docBrand()}<h1>МЕЖДУНАРОДНАЯ ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ (CMR)</h1><div class="sub">КДПГ / CMR ${cn("国际公路运输单")}</div>
    <table><tr><th style="width:50%">1. Отправитель ${cn("发货人")}</th><th>2. Получатель ${cn("收货人")}</th></tr>
    <tr><td>${esc(v.si.lat||v.seller)}<br>КНР (Китай)</td><td>${esc(v.buyer)}${v.bi.addr?"<br>"+esc(v.bi.addr):""}</td></tr>
    <tr><th>4. Место и дата погрузки ${cn("装货地")}</th><th>3. Место разгрузки ${cn("卸货地")}</th></tr>
    <tr><td>${portRu}, КНР · ${v.date}</td><td>${v.country==="KZ"?"Республика Казахстан":"Республика Узбекистан"}</td></tr>
    <tr><th>5. Прилагаемые документы</th><th>15. Условия оплаты</th></tr>
    <tr><td>Инвойс № ${esc(v.no)}, упаковочный лист, контракт ${esc(v.contract)}</td><td>${esc(v.terms)}</td></tr></table>
    <table><tr><th>6-9. Наименование груза</th><th>10. Код ТН ВЭД</th><th>11. Вес брутто, кг</th><th>12. Кол-во мест</th></tr>
    ${items.map(it=>`<tr><td>${esc(ruName(it))}</td><td class="num">${esc(it.hs)}</td><td class="num">—</td><td class="num">—</td></tr>`).join("")}
    <tr><td style="text-align:right"><b>Итого</b></td><td></td><td class="num"><b>${esc(v.gw)}</b></td><td class="num"><b>${esc(v.pkg)}</b></td></tr></table>
    <div class="row2"><span>16. Перевозчик: —</span><span>25/26. Рег. номер ТС ${cn("车牌")}: ${esc(v.truck)}</span></div>${seal()}${docFoot(id)}</div>`;
  D.bro=`<div class="doc">${docBrand()}<h1>${v.country==="KZ"?"СВЕДЕНИЯ ДЛЯ ЗАПОЛНЕНИЯ ДТ":"СВЕДЕНИЯ ДЛЯ ЗАПОЛНЕНИЯ ГТД (Т-6)"}</h1>
    <div class="sub">${v.country==="KZ"?"Декларация на товары (ЕАЭС) · для таможенного представителя":"Грузовая таможенная декларация · для таможенного брокера"} ${cn("申报资料表·给брокер")}</div>
    <table>
    <tr><th style="width:230px">Графа 2. Отправитель / Экспортер</th><td>${esc(v.si.lat||v.seller)}, КНР</td></tr>
    <tr><th>Графа 8. Получатель / Импортер</th><td>${esc(v.buyer)}${v.bi.bin?", БИН "+esc(v.bi.bin):""}${v.bi.addr?"<br>"+esc(v.bi.addr):""}</td></tr>
    <tr><th>Графа 11/15. Торгующая страна / Страна отправления</th><td>Китай (КНР), код CN</td></tr>
    <tr><th>Графа 20. Условия поставки</th><td>${esc(v.terms)}</td></tr>
    <tr><th>Графа 22. Валюта и общая фактурная стоимость</th><td class="num">${v.cur} ${fmt(v.t)}</td></tr>
    <tr><th>Графа 25. Вид транспорта на границе</th><td>${TRANS_RU[$("f_trans").value]||"автомобильный"} · ${esc(v.truck)} · п/п ${portRu}</td></tr>
    <tr><th>Графа 35 / 38. Вес брутто / нетто</th><td class="num">${esc(v.gw)} кг / ${esc(v.nw)} кг · мест: ${esc(v.pkg)}</td></tr>
    <tr><th>Графа 33. Код товара / ставка</th><td>${items.map(it=>`${esc(it.hs)} · ${esc(hsInfo(it.hs).ru)} · ${v.country==="KZ"?"пошлина "+dutyFor("KZ",it.hs)+"%":"ставку проверить по 10-значному коду"}`).join("<br>")}</td></tr>
    <tr><th>Графа 44. Прилагаемые документы</th><td>Контракт ${esc(v.contract)}; инвойс ${esc(v.no)}; упаковочный лист; CMR; сертификат происхождения / сведения о происхождении; платежные и банковские реквизиты</td></tr>
    <tr><th>Налоги и платежи</th><td>${v.country==="KZ"?"Ввозная пошлина по ЕТТ ЕАЭС; НДС 16%":"Пошлина по tarif.customs.uz; НДС 12%; проверить происхождение и возможные дополнительные меры"}</td></tr>
    ${v.bi.iban?`<tr><th>Банковские реквизиты получателя</th><td>${esc(v.bi.bank||"")}, IBAN ${esc(v.bi.iban)}${v.bi.bik?", БИК "+esc(v.bi.bik):""}</td></tr>`:""}</table>
    <p style="font-size:12px;font-weight:600">Графа 31/33/42. Товары ${cn("货物明细")}:</p>${tblRu}${seal()}${docFoot(id)}</div>`;
  D.broker=`<div class="doc">${docBrand()}<h1>ПАКЕТ СВЕДЕНИЙ ДЛЯ ТАМОЖЕННОГО ПРЕДСТАВИТЕЛЯ</h1>
    <div class="sub">${v.country==="KZ"?"Республика Казахстан · ДТ / ASTANA-1":"Республика Узбекистан · ГТД / электронное декларирование"} ${cn("报关代理委托资料")}</div>
    ${headRu}<table>
    <tr><th style="width:210px">Импортер</th><td>${esc(v.buyer)}${v.bi.bin?", БИН/ИНН "+esc(v.bi.bin):""}${v.bi.addr?"<br>"+esc(v.bi.addr):""}</td></tr>
    <tr><th>Экспортер</th><td>${esc(v.si.lat||v.seller)}, Китай</td></tr>
    <tr><th>Условия поставки / оплаты</th><td>${esc(v.terms)} · ${esc(trPay(v.pay))}</td></tr>
    <tr><th>Маршрут и транспорт</th><td>Китай, ${portRu} → ${v.country==="KZ"?"Казахстан":"Узбекистан"} · ${TRANS_RU[$("f_trans").value]||"автомобильный"} · ${esc(v.truck)}</td></tr>
    <tr><th>Просим проверить</th><td>10-значный код ТН ВЭД; таможенную стоимость; наличие сертификата происхождения; ограничения/сертификацию; расчет пошлины и НДС.</td></tr>
    <tr><th>Приложения</th><td>Контракт; инвойс; упаковочный лист; CMR; CO/сведения о происхождении; банковские реквизиты; фото/описание товара.</td></tr></table>
    ${tblRu}${seal()}${docFoot(id)}</div>`;
  const taxRows=items.map((it,i)=>{const amount=it.qty*it.price,k=taxCalc("KZ",amount,it.hs),u=taxCalc("UZ",amount,it.hs),info=hsInfo(it.hs);
    return `<tr><td>${i+1}</td><td>${esc(it.hs)}</td><td>${esc(info.cn)}</td><td class="num">${v.cur} ${fmt(amount)}</td><td class="num">${k.dutyRate}% / ${fmt(k.duty)}</td><td class="num">${fmt(k.vat)}</td><td class="num">${u.dutyRate}% / ${fmt(u.duty)}</td><td class="num">${fmt(u.vat)}</td></tr>`}).join("");
  const kt=taxTotals("KZ"),ut=taxTotals("UZ");
  D.tax=`<div class="doc">${docBrand()}<h1>进口税费测算表</h1><div class="sub">KZ / UZ Customs Duty & VAT · 合规库 ${RATE_VERSION}</div>
    <div class="meta"><span>合同号 ${esc(v.contract)}</span><span>币种 ${v.cur}</span><span>测算日期 ${today()}</span></div>
    <table><tr><th>项</th><th>HS</th><th>货物</th><th>货值</th><th>KZ关税</th><th>KZ НДС ${loadRates().kz.vat}%</th><th>UZ关税测算</th><th>UZ НДС ${loadRates().uz.vat}%</th></tr>${taxRows}
    <tr><td colspan="4" style="text-align:right"><b>合计</b></td><td class="num"><b>${fmt(kt.duty)}</b></td><td class="num"><b>${fmt(kt.vat)}</b></td><td class="num"><b>${fmt(ut.duty)}</b></td><td class="num"><b>${fmt(ut.vat)}</b></td></tr></table>
    <p style="font-size:12px;line-height:1.8;color:#444"><b>KZ依据：</b>${esc(loadRates().kz.dutyBasis)}；${esc(loadRates().kz.vatBasis)}<br><b>UZ依据：</b>${esc(loadRates().uz.dutyBasis)}；${esc(loadRates().uz.vatBasis)}<br>提示：本表用于报价和装运前核对，最终以进口国海关、брокер、税务机关核定为准。</p>${seal()}${docFoot(id)}</div>`;
  D.check=`<div class="doc">${docBrand()}<h1>通关合规核验清单</h1><div class="sub">中国出口 · 哈萨克斯坦/乌兹别克斯坦进口 · 装运前检查</div>
    <div class="meta"><span>合同号 ${esc(v.contract)}</span><span>目的国 ${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"}</span><span>核验日期 ${today()}</span></div>
    <table><tr><th style="width:34px">✓</th><th>项目</th><th>核验要求</th><th>本票数据</th></tr>
    ${[
      ["","合同/发票/装箱单一致","合同号、币种、金额、数量、买卖方名称一致",v.contract+" · "+v.cur+" "+fmt(v.t)],
      ["","HS编码","6305.32吨袋、6305.33 PP编织袋、6305.39其他纺织袋需按品名和材质区分",items.map(it=>it.hs+" "+hsInfo(it.hs).cn).join("; ")],
      ["","中国出口申报","境内发货人、境外收货人、成交方式、运抵国、商品编号、申报要素齐全","报关单草单 + 申报要素表"],
      ["","原产地/CO","对乌出口建议随附CO；对哈/乌均应留存原产地资料供进口审查","CO资料表 / 原产地声明"],
      ["","进口税费","KZ按ЕТТ ЕАЭС+НДС16%；UZ按tarif.customs.uz+НДС12%逐票核验","见税费测算表"],
      ["","运输资料","CMR、车牌/箱号、毛净重、件数、口岸一致",v.truck+" · "+v.gw+"/"+v.nw+" kg · "+v.pkg],
      ["","银行资料","IBAN/SWIFT/账号逐字符核对，付款方式与合同一致",(v.bi.iban||"")+(v.si.swift?" / "+v.si.swift:"")]
    ].map(r=>`<tr><td></td><td>${r[1]}</td><td>${r[2]}</td><td>${esc(r[3])}</td></tr>`).join("")}</table>
    <p style="font-size:12px;color:#444">本清单为业务核对工具，不替代报关行、律师或主管海关/税务机关意见。</p>${seal()}${docFoot(id)}</div>`;
  /* ---- 中文单证（《填制规范》官方用语） ---- */
  D.dec=`<div class="doc">${docBrand()}<h1>中华人民共和国海关出口货物报关单</h1><div class="sub">草 单（供报关行单一窗口预录入核对）</div>
    <table><tr><th style="width:120px">境内发货人</th><td>${esc(v.seller)}${v.si.tax?"（统一社会信用代码 "+esc(v.si.tax)+"）":""}</td><th style="width:90px">出境关别</th><td>${esc(v.port)}海关</td></tr>
    <tr><th>境外收货人</th><td>${esc(v.buyer)}</td><th>运输方式</th><td>${esc($("f_trans").value)}</td></tr>
    <tr><th>合同协议号</th><td class="num">${esc(v.contract)}</td><th>成交方式</th><td>${esc(v.terms.split(" ")[0])}</td></tr>
    <tr><th>贸易国(地区)</th><td>${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"}</td><th>币制</th><td>${v.cur}</td></tr>
    <tr><th>运抵国(地区)</th><td>${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"}</td><th>监管方式</th><td>一般贸易</td></tr></table>
    <table><tr><th>项号</th><th>商品编号</th><th>商品名称及规格型号</th><th>成交数量及单位</th><th>总价</th></tr>
    ${items.map((it,i)=>`<tr><td>${i+1}</td><td class="num">${esc(it.hs).replace(".","")}00</td><td>${esc(it.name)}</td><td class="num">${(+it.qty).toLocaleString()} 条</td><td class="num">${fmt(it.qty*it.price)}</td></tr>`).join("")}</table>
    <p style="font-size:12px;color:#444">毛重(千克) ${esc(v.gw)}　净重(千克) ${esc(v.nw)}　件数 ${esc(v.pkg)}　申报日期 ${v.date}</p>${seal()}${docFoot(id)}</div>`;
  D.ysys=`<div class="doc">${docBrand()}<h1>申 报 要 素 表</h1><div class="sub">编织袋 / 吨袋 · 供报关行规范申报</div>
    <div class="meta"><span>合同号 ${esc(v.contract)}</span><span>日期 ${v.date}</span><span>单证号 ${v.no}</span></div>
    ${items.map((it,i)=>`<table><tr><th colspan="2">项 ${i+1}：${esc(it.name)}（商品编号 ${esc(it.hs).replace(".","")}00）</th></tr>
    <tr><th style="width:130px">品名</th><td>${esc(it.name.split(" ")[0])}</td></tr>
    <tr><th>用途</th><td>包装用</td></tr>
    <tr><th>材质</th><td>聚丙烯（PP）塑料扁条编织</td></tr>
    <tr><th>规格型号</th><td>${esc(it.name)}</td></tr>
    <tr><th>品牌(中文或外文名称)</th><td>无品牌</td></tr>
    <tr><th>GTIN / CAS</th><td>无</td></tr></table>`).join("")}${seal()}${docFoot(id)}</div>`;
  D.co=`<div class="doc">${docBrand()}<h1>原产地证书（CO）申请资料整理表</h1><div class="sub">供向签证机构申领使用</div>
    <div class="meta"><span>合同号 ${esc(v.contract)}</span><span>日期 ${v.date}</span><span>单证号 ${v.no}</span></div>
    <table><tr><th style="width:140px">出口商</th><td>${esc(v.seller)}</td></tr>
    <tr><th>收货人</th><td>${esc(v.buyer)}</td></tr>
    <tr><th>运输路线</th><td>${esc(v.port)} → ${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"} · 公路运输</td></tr>
    <tr><th>唛头及包装件号</th><td>N/M</td></tr>
    <tr><th>原产地标准</th><td>中国完全获得 / 实质性改变（按签证机构要求填报）</td></tr></table>
    <table><tr><th>项号</th><th>商品名称及规格</th><th>HS编码</th><th>数量</th><th>发票金额</th></tr>
    ${items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(it.name)}</td><td class="num">${esc(it.hs)}</td><td class="num">${(+it.qty).toLocaleString()} 条</td><td class="num">${v.cur} ${fmt(it.qty*it.price)}</td></tr>`).join("")}</table>${seal()}${docFoot(id)}</div>`;
  D.origin=`<div class="doc">${docBrand()}<h1>原产地/非优惠原产地声明资料</h1><div class="sub">用于客户、报关代理、贸促会/签证机构核对</div>
    <div class="meta"><span>合同号 ${esc(v.contract)}</span><span>目的国 ${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"}</span><span>日期 ${v.date}</span></div>
    <table><tr><th style="width:150px">出口商/生产商</th><td>${esc(v.seller)}</td></tr>
    <tr><th>进口商/收货人</th><td>${esc(v.buyer)}</td></tr>
    <tr><th>原产国</th><td>中国（CN）</td></tr>
    <tr><th>运输路线</th><td>${esc(v.port)} → ${v.country==="KZ"?"哈萨克斯坦":"乌兹别克斯坦"} · ${esc($("f_trans").value)}</td></tr>
    <tr><th>随附文件</th><td>合同、商业发票、装箱单、CMR、生产/采购证明、必要时附照片和材质说明</td></tr>
    <tr><th>合规提示</th><td>${v.country==="UZ"?"对乌出口建议每票随附CO并让брокер确认是否涉及额外关税或原产地审查。":"对哈出口仍应留存原产地资料，供海关估价、监管或优惠审查时提交。"}</td></tr></table>
    <table><tr><th>项号</th><th>商品</th><th>HS</th><th>原产地依据</th><th>备注</th></tr>
    ${items.map((it,i)=>`<tr><td>${i+1}</td><td>${esc(it.name)}</td><td class="num">${esc(it.hs)}</td><td>中国生产/加工，材质与用途符合申报要素</td><td>${esc(hsInfo(it.hs).note)}</td></tr>`).join("")}</table>
    <p style="font-size:12px;color:#444">本页不是正式CO证书；正式证书须由有权签证机构签发或按目的国规则提交。</p>${seal()}${docFoot(id)}</div>`;
  return D[id]||"";
}
function drawDoc(){syncLangSel();const a=$("docArea");if(a)a.innerHTML=docHtml(curDoc)}
function printDoc(all){
  const ids=all?selectedTpls().map(t=>t.id):[curDoc];
  const saved=docLang;
  const docs=ids.map(id=>{
    const langs=DOC_LANGS[id]||["ru"];
    docLang=langs.includes(prefLang)?prefLang:langs[0]; // 每份单证按各自语言规则
    const html=docHtml(id),meta=DOC_META[id]||[id,""];
    return {id,html,title:meta[0]||id};
  });
  docs.forEach(d=>recordGeneratedDoc({kind:"form",docId:d.id,title:d.title,action:all?"导出全部已选单证":"导出当前单证PDF",html:d.html}));
  $("printArea").innerHTML=docs.map(d=>d.html).join("");
  docLang=saved;
  setTimeout(()=>window.print(),100);
}

/* ================= 存档 ================= */
function tickets(){try{return JSON.parse(localStorage.getItem("dd_tickets")||"[]")}catch(e){return[]}}
function setTickets(a){localStorage.setItem("dd_tickets",JSON.stringify(a))}
function docHistory(){try{return JSON.parse(localStorage.getItem("dd_doc_history")||"[]")}catch(e){return[]}}
function setDocHistory(a){localStorage.setItem("dd_doc_history",JSON.stringify(a.slice(0,80)))}
const DH_STATUS={review:["待审核","s-doc"],approved:["已审核","s-way"],archived:["已归档","s-done"]};
let remoteDocHistory=[],remoteArchiveFiles=[];
function jsArg(v){return JSON.stringify(String(v)).replace(/"/g,"&quot;")}
function recordGeneratedDoc(r){
  const d=collect(),meta=DOC_META[r.docId]||[r.title||r.docId,""];
  const rec={id:"doc-"+Date.now()+"-"+Math.floor(Math.random()*999),created:Date.now(),kind:r.kind||"form",docId:r.docId||"",title:r.title||meta[0]||"文件",action:r.action||"生成文件",status:"review",ticket_no:curTicket?curTicket.no:"",contract_no:d.contract||"",buyer:d.buyer||"",seller:d.seller||"",html:r.html||""};
  const a=docHistory();a.unshift(rec);setDocHistory(a);renderDocHistory();
  cloudSaveGeneratedDoc(rec);
}
function archiveRecordLine(r){
  const dt=new Date(r.created).toLocaleString("zh-CN",{hour12:false});
  const size=r.size_bytes?(" · "+Math.ceil(r.size_bytes/1024)+" KB"):"";
  return `<div class="archive-item">
    <span class="route imp">原件</span>
    <div class="a-main"><div class="t">${esc(r.title)} · ${esc(r.ticket_no||"未绑定票号")}</div>
    <div class="d">上传文件归档 · ${esc(dt)} · ${esc(r.category||"upload")}${size}</div></div>
    <span class="status s-done">已入库</span>
    <button class="mini" onclick="openArchiveFile(${jsArg(r.id)})">打开</button></div>`;
}
function docRecordLine(r){
  const st=DH_STATUS[r.status]||DH_STATUS.review,dt=new Date(r.created).toLocaleString("zh-CN",{hour12:false});
  if(r.remoteFile)return archiveRecordLine(r);
  return `<div class="archive-item">
    <span class="route ${r.kind==="contract"?"imp":""}">${r.kind==="contract"?"合同":"表单"}</span>
    <div class="a-main"><div class="t">${esc(r.title)} · ${esc(r.ticket_no||r.contract_no||"未绑定票号")}</div>
    <div class="d">${esc(r.action)} · ${esc(dt)} · 合同号 ${esc(r.contract_no||"—")} · ${esc(r.seller||"—")} → ${esc(r.buyer||"—")}</div></div>
    <button class="status ${st[1]}" onclick="approveDocRecord(${jsArg(r.id)})">${st[0]}</button>
    <button class="mini" onclick="viewDocRecord(${jsArg(r.id)})">查看</button>
    <button class="mini" onclick="archiveDocRecord(${jsArg(r.id)})">归档</button>
    <button class="mini del" onclick="deleteDocRecord(${jsArg(r.id)})">删</button></div>`;
}
function remoteDocRecords(){
  return remoteDocHistory.map(r=>Object.assign({},r,{remote:true,id:String(r.id),created:+r.created||Date.now()}));
}
function remoteFileRecords(){
  return remoteArchiveFiles.map(f=>({id:String(f.id),remoteFile:true,kind:"upload",title:f.filename||"上传文件",action:"上传文件归档",status:"archived",ticket_no:f.ticket_no||"",category:f.category||"",created:f.created_at?new Date(f.created_at).getTime():Date.now(),size_bytes:f.size_bytes||0}));
}
function allDocRecords(){
  const map=new Map();
  [...remoteDocRecords(),...docHistory().map(r=>Object.assign({},r,{id:String(r.id)})),...remoteFileRecords()].forEach(r=>{
    const key=(r.remoteFile?"file-":"doc-")+r.id;
    map.set(key,r);
  });
  return [...map.values()].sort((a,b)=>(b.created||0)-(a.created||0));
}
function renderDocHistory(){
  const el=$("docHistoryList");if(!el)return;
  const a=allDocRecords();
  if(!a.length){el.innerHTML='<div class="empty"><div class="big">📄</div>还没有生成/上传记录 · 导出合同、单证或上传原件后会自动出现在这里</div>';return}
  el.innerHTML=a.map(docRecordLine).join("");
}
function updateDocRecord(id,fn){
  id=String(id);
  const a=docHistory(),r=a.find(x=>String(x.id)===id);
  if(r){fn(r);setDocHistory(a);renderDocHistory();cloudSaveGeneratedDoc(r);return r}
  const rr=remoteDocHistory.find(x=>String(x.id)===id);
  if(rr){fn(rr);renderDocHistory();cloudUpdateGeneratedStatus(rr);return rr}
  return null;
}
function approveDocRecord(id){updateDocRecord(id,r=>{r.status=r.status==="approved"?"review":"approved";r.reviewed=Date.now()})}
function archiveDocRecord(id){updateDocRecord(id,r=>{r.status="archived";r.archived=Date.now()})}
function deleteDocRecord(id){
  id=String(id);
  if(!confirm("确定删除该生成记录？"))return;
  setDocHistory(docHistory().filter(r=>String(r.id)!==id));
  remoteDocHistory=remoteDocHistory.filter(r=>String(r.id)!==id);
  renderDocHistory();
  cloudDeleteGeneratedDoc(id);
}
function viewDocRecord(id){
  const r=allDocRecords().find(x=>String(x.id)===String(id));if(!r)return;
  if(r.remoteFile){openArchiveFile(r.id);return}
  go("p2");
  $("docArea").innerHTML=r.html||'<div class="empty">该记录没有可预览内容</div>';
  toast("已打开历史文件："+r.title);
}
function openArchiveFile(id){window.open(apiBase()+"/api/archive/file/"+encodeURIComponent(id),"_blank")}
function collect(){return{type:$("f_type").value,seller:$("f_seller").value,buyer:$("f_buyer").value,country:$("f_country").value,
  contract:$("f_contract").value,date:$("f_date").value,terms:$("f_terms").value,cur:$("f_cur").value,pay:$("f_pay").value,
  trans:$("f_trans").value,port:$("f_port").value,truck:$("f_truck").value,gw:$("f_gw").value,nw:$("f_nw").value,pkg:$("f_pkg").value,
  items:JSON.parse(JSON.stringify(items)),tpls:Object.assign({},tplState)}}
function saveTicket(){
  if(!curTicket)newTicket();
  Object.assign(curTicket,{data:collect(),total:total(),updated:Date.now()});
  const a=tickets(),i=a.findIndex(t=>t.id===curTicket.id);
  if(i>=0)a[i]=curTicket;else a.unshift(curTicket);
  setTickets(a);renderArchive();computeDash();toast("本票已保存 ✓ "+curTicket.no);
  cloudSaveTicket(curTicket);
}
function loadTicket(id){
  const t=tickets().find(x=>x.id===id);if(!t)return;
  curTicket=t;const d=t.data||{};items=d.items||[];tplState=d.tpls||{};
  $("f_type").value=d.type||"export";$("f_seller").value=d.seller||"";$("f_buyer").value=d.buyer||"";
  $("f_country").value=d.country||"KZ";$("f_contract").value=d.contract||"";$("f_date").value=d.date||today();
  setSelectOrAdd($("f_terms"),d.terms||"CPT Алматы");$("f_cur").value=d.cur||"USD";$("f_pay").value=d.pay||"";
  $("f_trans").value=d.trans||"公路卡航（中欧卡车）";$("f_port").value=d.port||"霍尔果斯";$("f_truck").value=d.truck||"";
  $("f_gw").value=d.gw||"";$("f_nw").value=d.nw||"";$("f_pkg").value=d.pkg||"";
  drawItems();render();go("p1");toast("已载入 "+t.no);
}
function copyTicket(id){
  loadTicket(id);
  curTicket=Object.assign({},curTicket,{id:Date.now(),no:ticketNo(),status:"doc",created:Date.now()});
  $("f_date").value=today();render();toast("已复制翻单 → 新票 "+curTicket.no+"，改数量后保存");
}
function delTicket(id){if(!confirm("确定删除该票？"))return;setTickets(tickets().filter(t=>t.id!==id));renderArchive();computeDash()}
const ST={doc:["单证中","s-doc"],way:["在途","s-way"],done:["已放行","s-done"]};
function cycleStatus(id){
  const a=tickets(),t=a.find(x=>x.id===id);if(!t)return;
  t.status=t.status==="doc"?"way":t.status==="way"?"done":"doc";
  setTickets(a);renderArchive();computeDash();
}
function renderArchive(){
  const a=tickets(),el=$("archiveList");
  if(!a.length)el.innerHTML='<div class="empty"><div class="big">🗂</div>还没有票据 · 去"合同识别"或"新建空白票"开始</div>';
  else el.innerHTML=a.map(t=>{
    const d=t.data||{},st=ST[t.status]||ST.doc;
    return `<div class="archive-item">
      <span class="route ${d.type==="import"?"imp":""}">${d.type==="import"?"进口·":"中国→"}${d.country||"KZ"}</span>
      <div class="a-main"><div class="t">${t.no} · ${esc(d.type==="import"?d.seller:d.buyer)||"—"}</div>
      <div class="d">${esc((d.items&&d.items[0]&&d.items[0].name)||"")} · ${d.cur||""} ${fmt(t.total||0)} · ${esc(d.port||"")}</div></div>
      <button class="status ${st[1]}" onclick="cycleStatus(${t.id})">${st[0]}</button>
      <button class="mini" onclick="loadTicket(${t.id})">打开</button>
      <button class="mini" onclick="copyTicket(${t.id})">复制翻单</button>
      <button class="mini del" onclick="delTicket(${t.id})">删</button></div>`;
  }).join("");
  renderDocHistory();
}
function exportBackup(){
  const blob=new Blob([JSON.stringify({company:loadCompany(),tickets:tickets(),docHistory:docHistory()},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="东大制单数据备份-"+today()+".json";a.click();
}
function importBackup(inp){
  const f=inp.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);
    if(d.tickets)setTickets(d.tickets);
    if(d.docHistory)setDocHistory(d.docHistory);
    if(d.company)localStorage.setItem("dd_company",JSON.stringify(d.company));
    fillCompanyForm();renderArchive();computeDash();toast("备份已恢复 ✓");
  }catch(e){alert("备份文件格式错误")}};
  r.readAsText(f);
}

/* ================= 仪表盘 ================= */
function computeDash(){
  const a=tickets(),now=new Date(),ym=now.toISOString().slice(0,7);
  const month=a.filter(t=>new Date(t.created).toISOString().slice(0,7)===ym);
  $("k1").textContent=month.length;$("k1d").textContent="全部票据 "+a.length+" 票";
  $("k2").textContent=a.filter(t=>t.status==="way").length;$("k2d").textContent="点击档案中状态可更新";
  const docs=a.filter(t=>t.status==="doc");$("k3").textContent=docs.length;
  const warns=docs.reduce((s,t)=>s+((t.warnings||[]).length),0);
  $("k3d").textContent=(rateStale()?"⚠ 税率核验超60天，请复核 · ":"")+(warns?warns+" 条预警待处理":"无预警");
  const sums={};month.forEach(t=>{const c=(t.data&&t.data.cur)||"USD";sums[c]=(sums[c]||0)+(t.total||0)});
  $("k4").textContent=Object.keys(sums).length?Object.entries(sums).map(([c,v])=>c+" "+fmt(v)).join(" + "):"—";
  $("k4d").textContent="本月已保存票合计";
  $("dashSub").textContent="掌握每一票的单证进度 · "+now.getFullYear()+"年"+(now.getMonth()+1)+"月";
  $("dashNo").innerHTML="当前票 <b>"+(curTicket?curTicket.no:"—")+"</b>";
  // 近6月柱状图
  const labels=[],counts=[];
  for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);const k=d.toISOString().slice(0,7);
    labels.push((d.getMonth()+1)+"月");counts.push(a.filter(t=>new Date(t.created).toISOString().slice(0,7)===k).length)}
  const max=Math.max(...counts,1);
  $("dashBars").innerHTML=counts.map((c,i)=>`<div class="b ${i===5?"hot":""}"><i style="height:${Math.round(c/max*100)}%"></i></div>`).join("");
  $("dashBarsX").innerHTML=labels.map(l=>`<span>${l}</span>`).join("");
}

/* ================= 通用 ================= */
function go(p){
  const target=p==="p2"?"p1":p;
  if(target==="p5"){const pin=loadCfg().pin;
    if(pin&&!adminOk){const x=prompt("请输入管理密码");
      if(x!==pin){alert("密码错误，无权进入系统设置");return}adminOk=true;}}
  document.querySelectorAll(".panel").forEach(x=>x.classList.toggle("active",x.id===target));
  document.querySelectorAll(".nav-item[data-p],.mnav .mi").forEach(s=>s.classList.toggle("active",s.dataset.p===target));
  if(p==="p2"){
    drawDoc();
    const sec=$("docPreviewSection");
    if(sec)setTimeout(()=>sec.scrollIntoView({behavior:"smooth",block:"start"}),60);
  }else window.scrollTo({top:0});
  if(target==="pd")computeDash();if(target==="p3"){renderArchive();refreshCloudArchive()}
}
let toastTimer=null;
function toast(msg){const t=$("toast");t.textContent=msg;t.style.display="block";clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.style.display="none",3400)}

/* ================= API接口设置 ================= */
function apiCfg(){try{return JSON.parse(localStorage.getItem("dd_api")||"{}")}catch(e){return{}}}
function apiBase(){const b=(apiCfg().base||"").trim().replace(/\/+$/,"");return b||""}
function fillApiForm(){const c=apiCfg();if($("api_base"))$("api_base").value=c.base||"";if($("api_ch"))$("api_ch").value=c.ch||"2"}
function saveApi(){localStorage.setItem("dd_api",JSON.stringify({base:$("api_base").value.trim(),ch:$("api_ch").value}));toast("接口设置已保存 ✓");testApi()}
async function testApi(){const s=$("apiStatus");s.textContent="测试中…";s.style.color="var(--steel)";
  try{const r=await fetch(apiBase()+"/healthz",{cache:"no-store"});
    if(r.ok){let db="";
      try{const d=await fetch(apiBase()+"/api/db/status",{cache:"no-store"}).then(x=>x.json());db=d.enabled?" · 数据库已连接":" · 未配置数据库"}catch(e){db=" · 数据库未确认"}
      s.textContent="✓ 后端连接正常"+db;s.style.color="var(--ok)"}
    else{s.textContent="✗ 后端响应异常 "+r.status;s.style.color="var(--bad)"}
  }catch(e){s.textContent="✗ 连不上后端——请确认网址或先部署（可先用演示模式）";s.style.color="var(--bad)"}}

async function cloudArchiveFiles(files,category,ticketNo){
  if(!files||!files.length)return;
  try{
    const r=await fetch(apiBase()+"/api/archive/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files,category,ticket_no:ticketNo||""})});
    if(r.ok){const d=await r.json();if(d.files&&d.files.length){toast("上传文件已归档到数据库 ✓ "+d.files.length+" 个");loadRemoteArchiveFiles()}}
  }catch(e){}
}
async function cloudSaveTicket(ticket){
  try{await fetch(apiBase()+"/api/tickets/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticket})})}catch(e){}
}
async function cloudSaveGeneratedDoc(record){
  if(!record||!record.html)return;
  try{
    const r=await fetch(apiBase()+"/api/generated/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({record})});
    if(r.ok)loadRemoteDocHistory();
  }catch(e){}
}
async function cloudUpdateGeneratedStatus(record){
  if(!record||!record.id)return;
  try{await fetch(apiBase()+"/api/generated/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:record.id,status:record.status||"review"})})}catch(e){}
}
async function cloudDeleteGeneratedDoc(id){
  try{await fetch(apiBase()+"/api/generated/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})})}catch(e){}
}
async function loadRemoteDocHistory(){
  try{
    const r=await fetch(apiBase()+"/api/generated/list?limit=100",{cache:"no-store"});
    if(!r.ok)return;
    const d=await r.json();
    remoteDocHistory=Array.isArray(d.docs)?d.docs:[];
    renderDocHistory();
  }catch(e){}
}
async function loadRemoteArchiveFiles(){
  try{
    const r=await fetch(apiBase()+"/api/archive/list?limit=100",{cache:"no-store"});
    if(!r.ok)return;
    const d=await r.json();
    remoteArchiveFiles=Array.isArray(d.files)?d.files:[];
    renderDocHistory();
  }catch(e){}
}
async function loadRemoteTickets(){
  try{
    const r=await fetch(apiBase()+"/api/tickets/list?limit=200",{cache:"no-store"});
    if(!r.ok)return;
    const d=await r.json(),remote=Array.isArray(d.tickets)?d.tickets:[];
    if(!remote.length)return;
    const map=new Map(tickets().map(t=>[String(t.id),t]));
    remote.forEach(t=>{if(t&&t.id&&!map.has(String(t.id)))map.set(String(t.id),t)});
    setTickets([...map.values()].sort((a,b)=>(b.updated||b.created||0)-(a.updated||a.created||0)));
    renderArchive();computeDash();
  }catch(e){}
}
function refreshCloudArchive(){loadRemoteTickets();loadRemoteDocHistory();loadRemoteArchiveFiles()}

/* ================= PWA 本地安装 ================= */
let deferredInstallPrompt=null;
window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  deferredInstallPrompt=e;
  const b=$("installPwaBtn");if(b)b.style.display="inline-flex";
});
window.addEventListener("appinstalled",()=>{
  deferredInstallPrompt=null;
  const b=$("installPwaBtn");if(b)b.style.display="none";
  toast("已安装到本机 ✓");
});
async function installPWA(){
  if(!deferredInstallPrompt){toast("可从浏览器地址栏/菜单选择安装此应用");return}
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt=null;
  const b=$("installPwaBtn");if(b)b.style.display="none";
}
if("serviceWorker" in navigator){
  window.addEventListener("load",()=>{
    navigator.serviceWorker.register("/sw.js").catch(()=>{});
  });
}

function bindTemplateButtons(){
  const binds=[
    ["btnContractBaseLoad",applyContractBaseSource],
    ["btnApplyContract",applyContractTemplate],
    ["btnPreviewContract",()=>previewContractTemplate(true)],
    ["btnExportContract",exportContractTemplate],
    ["btnCopyContractParams",copyContractParams],
    ["btnApplyFormTpl",applyFormTemplate],
    ["btnToggleFormTpl",toggleFormTemplate]
  ];
  binds.forEach(([id,fn])=>{
    const el=$(id);if(!el||el.dataset.bound)return;
    el.removeAttribute("onclick");
    el.addEventListener("click",e=>{e.preventDefault();fn()});
    el.dataset.bound="1";
  });
  if(!window.__ddTemplateDelegation){
    document.addEventListener("click",e=>{
      const c=e.target.closest("[data-contract-id]");
      if(c){e.preventDefault();selectContractTemplate(c.dataset.contractId);return}
      const f=e.target.closest("[data-form-id]");
      if(f){e.preventDefault();selectFormTemplate(f.dataset.formId)}
    });
    window.__ddTemplateDelegation=true;
  }
}

Object.assign(window,{
  addContractItem,addRow,applyContractBaseSource,applyContractTemplate,applyExtract,approveDocRecord,archiveDocRecord,copyContractItem,copyContractParams,
  copyTicket,cycleStatus,deleteDocRecord,delContractItem,delItem,delTicket,demoRecognize,exportBackup,
  exportContractTemplate,go,importBackup,installPWA,applyFormTemplate,
  loadTicket,newTicket,onTypeChange,onUpload,pickDoc,printDoc,render,resetCfg,
  openArchiveFile,refreshCloudArchive,renderDocHistory,recordGeneratedDoc,
  previewContractTemplate,resetRecognize,saveApi,saveCfg,saveCompany,saveRates,saveTicket,selectContractTemplate,
  selectFormTemplate,setContractLang,setDocLang,setFormLang,setSealMode,setSealPosition,startRecognize,syncContractItemsFromEntry,testApi,toggleFormTemplate,tplToggle,viewDocRecord,wipeAll
});

/* ================= 初始化 ================= */
fillApiForm();fillRatesForm();fillCfgForm();applyCfg();
fillCompanyForm();
newTicket("export");
bindTemplateButtons();
renderArchive();
computeDash();
refreshCloudArchive();
