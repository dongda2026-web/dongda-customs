/* 东大制单工作台 · 后端 v1.0
 * 多层验证识别管线：
 *   层1 双通道独立识别(Claude A提取员 + B稽核员并行)
 *   层2 字段交叉比对(逐字段/逐字符)
 *   层3 规则引擎(金额/IBAN mod-97/SWIFT/HS/日期/占位符，纯代码)
 *   层4 置信度融合 → 通过/核对/阻断
 * 部署：Render Web Service · 环境变量 ANTHROPIC_API_KEY 必填
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const publicDir = path.join(__dirname, "public");
const JSON_LIMIT = 60 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(new Error("请求体超过 60MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("JSON 格式错误：" + err.message));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir + path.sep)) return sendText(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const CHANNELS = +(process.env.RECOG_CHANNELS || 2); // 1=省钱单通道, 2=双通道

/* ============ PostgreSQL 持久化（Render DATABASE_URL） ============ */
let pool = null, dbInit = null;
function dbConfigured() { return !!process.env.DATABASE_URL; }
function getPool() {
  if (!dbConfigured()) return null;
  if (pool) return pool;
  let Pool;
  try {
    Pool = require("pg").Pool;
  } catch (err) {
    throw new Error("已配置 DATABASE_URL，但未安装 pg 依赖。请在 Render Build Command 使用 npm install。");
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  return pool;
}
async function ensureDb() {
  const p = getPool();
  if (!p) return null;
  if (!dbInit) dbInit = (async () => {
    await p.query(`
      create table if not exists uploaded_files (
        id text primary key,
        filename text not null,
        media_type text,
        size_bytes integer not null default 0,
        category text,
        ticket_no text,
        sha256 text,
        data bytea not null,
        created_at timestamptz not null default now()
      );
      create index if not exists uploaded_files_created_idx on uploaded_files(created_at desc);
      create index if not exists uploaded_files_ticket_idx on uploaded_files(ticket_no);
      create table if not exists tickets (
        id text primary key,
        ticket_no text,
        payload jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists tickets_updated_idx on tickets(updated_at desc);
      create table if not exists generated_docs (
        id text primary key,
        title text not null,
        kind text,
        doc_id text,
        action text,
        status text not null default 'review',
        ticket_no text,
        contract_no text,
        seller text,
        buyer text,
        html text not null,
        payload jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists generated_docs_created_idx on generated_docs(created_at desc);
      create index if not exists generated_docs_ticket_idx on generated_docs(ticket_no);
    `);
    return p;
  })();
  return dbInit;
}
function fileId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"); }
function cleanFileName(name, fallback) {
  return String(name || fallback || "upload.bin").replace(/[\\/\0]/g, "_").slice(0, 160);
}
async function saveUploadedFiles(files, meta = {}) {
  const p = await ensureDb();
  if (!p) return { ok: false, disabled: true, files: [] };
  const saved = [];
  for (const f of (files || []).slice(0, 20)) {
    if (!f || !f.data) continue;
    const buf = Buffer.from(f.data, "base64");
    const id = fileId();
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const filename = cleanFileName(f.name, id);
    await p.query(
      `insert into uploaded_files (id, filename, media_type, size_bytes, category, ticket_no, sha256, data)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, filename, f.media_type || "application/octet-stream", buf.length, meta.category || "upload", meta.ticket_no || "", sha256, buf]
    );
    saved.push({ id, filename, media_type: f.media_type || "", size_bytes: buf.length, sha256 });
  }
  return { ok: true, files: saved };
}

const SCHEMA = `只返回一个JSON对象，禁止任何其他文字、禁止markdown代码块。结构：
{"ticket_type":"export或import","contract_no":"中文版合同号","contract_no_alt":"外文版合同号(与中文版相同则填空串)","sign_date":"YYYY-MM-DD",
"seller":{"name":"","name_lat":"","address":"","bank":"","swift":"","account":"","tax_id":""},
"buyer":{"name":"","address":"","bank":"","iban":"","bik":"","bin":"","swift":""},
"destination_country":"KZ或UZ或CN或OTHER","currency":"CNY/USD/RUB/EUR",
"goods":[{"name":"品名(中文)","name_ru":"品名(俄文,合同俄文部分原文)","spec":"规格(中文)","spec_ru":"规格(俄文,合同俄文部分原文)","hs":"HS编码原文","qty":0,"unit":"","price":0,"amount":0}],
"total":0,"total_words":"大写金额原文","terms":"贸易条款,合同留空则填空串","payment":"","delivery_date":"",
"confidence":{"contract_no":0,"seller":0,"buyer":0,"goods":0,"total":0,"terms":0,"payment":0}}
所有数值保持原文精度。ticket_type判断：中国公司(立天/东大/疆塑等中方)为卖方=export；哈国/乌国东大为买方从中国采购=import。`;

const PROMPT_A = "你是中国—中亚外贸单证提取专家。从上传的合同(中/俄/英文,可能是扫描件)中完整提取以下信息。" + SCHEMA;
const PROMPT_B = "你是独立审单稽核员，与他人互不通气。请独立地从合同中逐字提取信息，特别注意：编号、金额、数量、银行账号要逐字符核对原文，中文版与外文版分别核对。" + SCHEMA;

async function callClaude(content, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: [...content, { type: "text", text: prompt }] }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("Claude API: " + JSON.stringify(data).slice(0, 300));
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
}

/* ============ 层3 规则引擎（确定性校验，不依赖AI） ============ */
const norm = v => String(v == null ? "" : v).replace(/\s+/g, "").toUpperCase();
function ibanCheck(iban) {
  const s = norm(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(s)) return false;
  if (s.startsWith("KZ") && s.length !== 20) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let num = "";
  for (const c of re) num += parseInt(c, 36).toString();
  // 大数 mod 97
  let rem = 0;
  for (let i = 0; i < num.length; i += 7) rem = +(String(rem) + num.substr(i, 7)) % 97;
  return rem === 1;
}
const swiftCheck = s => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(norm(s));
const PLACEHOLDER = /\[|\]|此处|填写|указать|заполнить|TBD|XXX/i;
const HS_LIB = {
  "630533": "PP编织袋(聚乙烯/聚丙烯条) — EAEU进口关税10%",
  "630532": "集装袋/吨袋(FIBC柔性中型散装容器) — EAEU进口关税10%",
  "630539": "其他纺织材料软袋 — EAEU进口关税7%，吨袋/编织袋用此码需核对",
  "392321": "聚乙烯塑料袋", "392329": "其他塑料袋",
};
function ruleEngine(d) {
  const rules = [];
  const add = (rule, pass, msg, level) => rules.push({ rule, pass, msg, level: level || "mid" });
  // 1 金额连乘与合计
  let sum = 0, lineOk = true;
  (d.goods || []).forEach((g, i) => {
    const calc = +(g.qty * g.price).toFixed(2);
    sum += g.amount || calc;
    if (g.amount && Math.abs(calc - g.amount) > 0.05) { lineOk = false; add("金额连乘", false, `第${i + 1}行 数量×单价=${calc} ≠ 行金额${g.amount}`, "high"); }
  });
  if (lineOk) add("金额连乘", true, "各行 数量×单价 与行金额一致");
  if (d.total) {
    const ok = Math.abs(sum - d.total) <= 0.05;
    add("合计校验", ok, ok ? `明细合计=${d.total} 与合同总额一致` : `明细合计${sum.toFixed(2)} ≠ 合同总额${d.total}`, ok ? "mid" : "high");
  }
  // 2 中外文合同号
  if (d.contract_no_alt && norm(d.contract_no_alt) !== norm(d.contract_no))
    add("版本比对", false, `中文版合同号 ${d.contract_no} 与外文版 ${d.contract_no_alt} 不一致`, "high");
  else add("版本比对", true, "中外文版合同号一致");
  // 3 贸易条款
  if (!d.terms || PLACEHOLDER.test(d.terms)) add("条款完整性", false, "贸易条款(Incoterms)缺失或为占位符，无法出CMR/申报", "high");
  else add("条款完整性", true, "贸易条款已填写: " + d.terms);
  // 4 HS编码
  (d.goods || []).forEach((g, i) => {
    const hs6 = norm(g.hs).replace(/\./g, "").slice(0, 6);
    const name = (g.name || "") + (g.spec || "");
    if (!HS_LIB[hs6]) add("HS编码", false, `第${i + 1}行 HS ${g.hs} 不在编织袋类常用编码库，请核对`, "mid");
    else if (/吨袋|集装袋|биг|big\s*bag|fibc/i.test(name) && hs6 !== "630532")
      add("HS编码", false, `第${i + 1}行为吨袋/集装袋，建议核对 6305.32（当前 ${g.hs}）`, "mid");
    else add("HS编码", true, `第${i + 1}行 HS ${g.hs} · ${HS_LIB[hs6]}`);
  });
  // 5 银行
  if (d.buyer && d.buyer.iban) add("IBAN校验位", ibanCheck(d.buyer.iban), ibanCheck(d.buyer.iban) ? "买方IBAN mod-97校验通过" : "买方IBAN校验位不符，请逐字核对", ibanCheck(d.buyer.iban) ? "mid" : "high");
  if (d.seller && d.seller.swift) add("SWIFT格式", swiftCheck(d.seller.swift), swiftCheck(d.seller.swift) ? "卖方SWIFT格式正确" : "卖方SWIFT格式异常");
  // 6 日期逻辑
  if (d.sign_date && d.delivery_date && /^\d{4}-\d{2}-\d{2}$/.test(d.delivery_date) && d.delivery_date < d.sign_date)
    add("日期逻辑", false, "交货期早于签约日期", "high");
  // 7 占位符扫描
  const flat = JSON.stringify(d);
  if (/\[此处|\[указать|\[заполнить/i.test(flat)) add("占位符扫描", false, "合同存在未填写的占位字段", "high");
  return rules;
}

/* ============ 层2+4 通道比对与置信度融合 ============ */
const CMP_FIELDS = [
  ["contract_no", d => d.contract_no], ["total", d => d.total], ["currency", d => d.currency],
  ["terms", d => d.terms], ["payment", d => d.payment], ["delivery_date", d => d.delivery_date],
  ["seller", d => d.seller && d.seller.name], ["buyer", d => d.buyer && d.buyer.name],
  ["iban", d => d.buyer && d.buyer.iban], ["goods_count", d => (d.goods || []).length],
  ["goods_qty", d => (d.goods || []).map(g => g.qty).join(",")],
  ["goods_price", d => (d.goods || []).map(g => g.price).join(",")],
];
function crossCheck(a, b) {
  return CMP_FIELDS.map(([f, get]) => ({ field: f, match: norm(get(a)) === norm(get(b)) }));
}
function fuse(a, consistency, rules) {
  const status = {}; // 字段 → ok / check / block
  const confOf = f => (a.confidence && a.confidence[f]) || 90;
  const consMap = {}; consistency.forEach(c => consMap[c.field] = c.match);
  const fields = ["contract_no", "seller", "buyer", "goods", "total", "terms", "payment"];
  fields.forEach(f => {
    let s = confOf(f) >= 85 ? "ok" : "check";
    if (consMap[f] === false) s = "check";
    status[f] = s;
  });
  // 规则high失败 → 阻断对应字段
  rules.filter(r => !r.pass && r.level === "high").forEach(r => {
    if (/金额|合计/.test(r.rule)) status.total = "block";
    if (/版本/.test(r.rule)) status.contract_no = "block";
    if (/条款/.test(r.rule)) status.terms = "block";
    if (/IBAN/.test(r.rule)) status.buyer = "block";
    if (/日期/.test(r.rule)) status.payment = "check";
  });
  if (consMap.goods_qty === false || consMap.goods_price === false || consMap.goods_count === false) status.goods = "block";
  return status;
}

async function recognize(req, res) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 500, { error: "服务器未配置 ANTHROPIC_API_KEY" });
    const body = await readJson(req);
    const files = body && body.files;
    if (!Array.isArray(files) || !files.length) return sendJson(res, 400, { error: "未收到文件" });
    let archive = null;
    if (process.env.AUTO_ARCHIVE_UPLOADS !== "0") {
      try { archive = await saveUploadedFiles(files, { category: body.category || "recognize", ticket_no: body.ticket_no || "" }); }
      catch (err) { archive = { ok: false, error: err.message }; }
    }
    const content = [];
    for (const f of files.slice(0, 8)) {
      if (f.media_type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      else if (/^image\//.test(f.media_type || "")) content.push({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } });
    }
    if (!content.length) return sendJson(res, 400, { error: "仅支持 PDF / 图片" });

    // 层1 双通道并行
    let A, B = null;
    if (CHANNELS >= 2) [A, B] = await Promise.all([callClaude(content, PROMPT_A), callClaude(content, PROMPT_B)]);
    else A = await callClaude(content, PROMPT_A);
    // 层2 交叉比对
    const consistency = B ? crossCheck(A, B) : [];
    // 层3 规则引擎
    const rules = ruleEngine(A);
    // 层4 融合
    const fieldStatus = fuse(A, consistency, rules);
    sendJson(res, 200, { ok: true, result: A, verification: { channels: B ? 2 : 1, consistency, rules, fieldStatus }, archive });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "识别失败：" + err.message });
  }
}

async function dbStatus(_, res) {
  try {
    const p = await ensureDb();
    if (!p) return sendJson(res, 200, { ok: true, enabled: false, message: "未配置 DATABASE_URL" });
    const r = await p.query("select now() as now");
    sendJson(res, 200, { ok: true, enabled: true, now: r.rows[0].now });
  } catch (err) {
    sendJson(res, 500, { ok: false, enabled: dbConfigured(), error: err.message });
  }
}

async function archiveUpload(req, res) {
  try {
    const body = await readJson(req);
    const files = body && body.files;
    if (!Array.isArray(files) || !files.length) return sendJson(res, 400, { error: "未收到文件" });
    const saved = await saveUploadedFiles(files, { category: body.category || "upload", ticket_no: body.ticket_no || "" });
    if (saved.disabled) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL，无法保存文件" });
    sendJson(res, 200, saved);
  } catch (err) {
    sendJson(res, 500, { error: "保存文件失败：" + err.message });
  }
}

async function archiveList(req, res) {
  try {
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(Math.max(+(url.searchParams.get("limit") || 50), 1), 200);
    const r = await p.query(
      `select id, filename, media_type, size_bytes, category, ticket_no, sha256, created_at
       from uploaded_files order by created_at desc limit $1`,
      [limit]
    );
    sendJson(res, 200, { ok: true, files: r.rows });
  } catch (err) {
    sendJson(res, 500, { error: "读取文件列表失败：" + err.message });
  }
}

async function archiveDownload(req, res, id) {
  try {
    const p = await ensureDb();
    if (!p) return sendText(res, 503, "DATABASE_URL not configured");
    const r = await p.query("select filename, media_type, data from uploaded_files where id=$1", [id]);
    if (!r.rowCount) return sendText(res, 404, "Not found");
    const f = r.rows[0];
    res.writeHead(200, {
      "content-type": f.media_type || "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    });
    res.end(f.data);
  } catch (err) {
    sendText(res, 500, "Download failed: " + err.message);
  }
}

async function ticketSave(req, res) {
  try {
    const body = await readJson(req);
    const ticket = body && body.ticket;
    if (!ticket || !ticket.id) return sendJson(res, 400, { error: "缺少 ticket.id" });
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    await p.query(
      `insert into tickets (id, ticket_no, payload, updated_at)
       values ($1,$2,$3,now())
       on conflict (id) do update set ticket_no=excluded.ticket_no, payload=excluded.payload, updated_at=now()`,
      [String(ticket.id), ticket.no || "", JSON.stringify(ticket)]
    );
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: "保存票据失败：" + err.message });
  }
}

async function ticketList(req, res) {
  try {
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(Math.max(+(url.searchParams.get("limit") || 100), 1), 500);
    const r = await p.query("select payload from tickets order by updated_at desc limit $1", [limit]);
    sendJson(res, 200, { ok: true, tickets: r.rows.map(x => x.payload) });
  } catch (err) {
    sendJson(res, 500, { error: "读取票据失败：" + err.message });
  }
}

async function generatedSave(req, res) {
  try {
    const body = await readJson(req);
    const record = body && body.record;
    if (!record || !record.html) return sendJson(res, 400, { error: "缺少生成文件内容" });
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    const id = String(record.id || fileId());
    const createdAt = record.created ? new Date(record.created) : new Date();
    await p.query(
      `insert into generated_docs
       (id, title, kind, doc_id, action, status, ticket_no, contract_no, seller, buyer, html, payload, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       on conflict (id) do update set
       title=excluded.title, kind=excluded.kind, doc_id=excluded.doc_id, action=excluded.action,
       status=excluded.status, ticket_no=excluded.ticket_no, contract_no=excluded.contract_no,
       seller=excluded.seller, buyer=excluded.buyer, html=excluded.html, payload=excluded.payload, updated_at=now()`,
      [
        id,
        String(record.title || "生成文件").slice(0, 200),
        String(record.kind || "form").slice(0, 40),
        String(record.docId || record.doc_id || "").slice(0, 80),
        String(record.action || "生成文件").slice(0, 80),
        String(record.status || "review").slice(0, 30),
        String(record.ticket_no || "").slice(0, 120),
        String(record.contract_no || "").slice(0, 120),
        String(record.seller || "").slice(0, 240),
        String(record.buyer || "").slice(0, 240),
        String(record.html || ""),
        JSON.stringify(record),
        createdAt,
      ]
    );
    sendJson(res, 200, { ok: true, id });
  } catch (err) {
    sendJson(res, 500, { error: "保存生成文件失败：" + err.message });
  }
}

async function generatedList(req, res) {
  try {
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(Math.max(+(url.searchParams.get("limit") || 80), 1), 200);
    const r = await p.query(
      `select id, title, kind, doc_id, action, status, ticket_no, contract_no, seller, buyer, html, created_at, updated_at
       from generated_docs order by created_at desc limit $1`,
      [limit]
    );
    sendJson(res, 200, {
      ok: true,
      docs: r.rows.map(x => ({
        id: x.id,
        title: x.title,
        kind: x.kind,
        docId: x.doc_id,
        action: x.action,
        status: x.status,
        ticket_no: x.ticket_no,
        contract_no: x.contract_no,
        seller: x.seller,
        buyer: x.buyer,
        html: x.html,
        created: x.created_at ? new Date(x.created_at).getTime() : Date.now(),
        updated: x.updated_at,
        remote: true,
      })),
    });
  } catch (err) {
    sendJson(res, 500, { error: "读取生成文件失败：" + err.message });
  }
}

async function generatedStatus(req, res) {
  try {
    const body = await readJson(req);
    const id = body && body.id;
    const status = body && body.status;
    if (!id || !["review", "approved", "archived"].includes(status)) return sendJson(res, 400, { error: "状态参数不正确" });
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    const r = await p.query("update generated_docs set status=$2, updated_at=now() where id=$1", [String(id), status]);
    if (!r.rowCount) return sendJson(res, 404, { error: "记录不存在" });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: "更新生成文件状态失败：" + err.message });
  }
}

async function generatedDelete(req, res) {
  try {
    const body = await readJson(req);
    const id = body && body.id;
    if (!id) return sendJson(res, 400, { error: "缺少 id" });
    const p = await ensureDb();
    if (!p) return sendJson(res, 503, { error: "服务器未配置 DATABASE_URL" });
    await p.query("delete from generated_docs where id=$1", [String(id)]);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: "删除生成文件失败：" + err.message });
  }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/healthz") return sendText(res, 200, "ok");
  if (req.method === "GET" && pathname === "/api/db/status") return dbStatus(req, res);
  if (req.method === "POST" && pathname === "/api/recognize") return recognize(req, res);
  if (req.method === "POST" && pathname === "/api/archive/upload") return archiveUpload(req, res);
  if (req.method === "GET" && pathname === "/api/archive/list") return archiveList(req, res);
  if (req.method === "GET" && pathname.startsWith("/api/archive/file/")) return archiveDownload(req, res, decodeURIComponent(pathname.slice("/api/archive/file/".length)));
  if (req.method === "POST" && pathname === "/api/tickets/save") return ticketSave(req, res);
  if (req.method === "GET" && pathname === "/api/tickets/list") return ticketList(req, res);
  if (req.method === "POST" && pathname === "/api/generated/save") return generatedSave(req, res);
  if (req.method === "GET" && pathname === "/api/generated/list") return generatedList(req, res);
  if (req.method === "POST" && pathname === "/api/generated/status") return generatedStatus(req, res);
  if (req.method === "POST" && pathname === "/api/generated/delete") return generatedDelete(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  sendText(res, 405, "Method not allowed");
}).listen(PORT, HOST, () => console.log("东大制单工作台 · " + HOST + ":" + PORT + " · 识别通道 " + CHANNELS));
