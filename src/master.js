"use strict";
const { text, AppError } = require("./http");
const { requireRole } = require("./auth");
const r = require("./records");
const definitions = {
  partners: { table: "partners", roles: ["sales", "purchasing", "social"] },
  products: { table: "products", roles: ["purchasing"] },
  warehouses: { table: "warehouses", roles: [] },
  "social-accounts": { table: "social_accounts", roles: ["social"] },
};

function values(type, body) {
  const base = { name: text(body.name, "name"), active: body.active === undefined ? true : body.active };
  if (typeof base.active !== "boolean") throw new AppError(422, "VALIDATION", "Invalid active flag");
  if (type === "partners") return {
    ...base, kind: r.choice(body.kind, "kind", ["customer", "supplier", "both"]),
    email: text(body.email || "", "email", 254, false),
    contact: text(body.contact || "", "contact", 200, false),
    country: text(body.country || "", "country", 80, false),
    address: text(body.address || "", "address", 1000, false),
  };
  if (type === "products") return {
    ...base, code: text(body.code, "code", 80), unit: text(body.unit, "unit", 30),
    price: r.decimal(body.price || "0", "price"), currency: r.currency(body.currency || "USD"),
    spec: text(body.spec || "", "spec", 1000, false), hs_code: text(body.hs_code || "", "hs_code", 20, false),
  };
  if (type === "warehouses") return {
    ...base, code: text(body.code, "code", 80),
    kind: r.choice(body.kind, "kind", ["domestic", "bonded", "overseas", "fba", "transit"]),
  };
  return { ...base, platform: r.choice(body.platform, "platform", [
    "whatsapp", "facebook", "instagram", "tiktok", "telegram", "wechat", "douyin", "linkedin", "other",
  ]), handle: text(body.handle || "", "handle", 200, false) };
}

async function handle(c, actor, type, id, method, body, query) {
  const def = definitions[type];
  if (!def) return null;
  if (method === "GET") return { status: 200, body: id ? await r.get(c, actor, def.table, id) : await r.list(c, actor, def.table, query) };
  requireRole(actor, ...def.roles);
  if (method === "POST" && !id) return { status: 201, body: await r.insert(c, actor, def.table, values(type, body)) };
  if (method === "PATCH" && id) {
    const row = await r.get(c, actor, def.table, id, true);
    r.version(row, body.version);
    return { status: 200, body: await r.update(c, actor, def.table, row, values(type, { ...row, ...body })) };
  }
  throw new AppError(405, "METHOD_NOT_ALLOWED", "Use create, edit or deactivate");
}
module.exports = { handle, definitions };
