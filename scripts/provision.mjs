/* 首次开通：为已迁移的数据库创建 1 个企业租户与 1 个管理员成员。
 *
 * 这是"平台开租户"能力的临时最小实现，供部署后人工初始化使用。
 * 幂等：重复执行不会新建租户/用户/成员，也不会重置已有密码。
 * 安全：密码只从环境变量读取，绝不打印；缺失必要身份时拒绝执行。
 *
 * 必填环境变量：
 *   DATABASE_URL        目标数据库（不读应用默认值）
 *   ERP_TENANT_SLUG     企业标识（小写字母/数字/连字符）
 *   ERP_TENANT_NAME     企业名称
 *   ERP_ADMIN_EMAIL     管理员邮箱
 *   ERP_ADMIN_PASSWORD  管理员初始密码（>=12 位）
 * 可选：
 *   DB_SSL=false        连接内网数据库时关闭 SSL
 *   ERP_RUNTIME_ROLE    迁移授权使用的角色，默认取当前连接用户
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPool, migrate } = require("../src/db");
const { hashPassword } = require("../src/auth");

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function fail(message) {
  // 只输出可诊断的信息，不回显任何密码或连接串。
  console.error(`开通失败：${message}`);
  process.exit(2);
}

if (!(process.env.DATABASE_URL || "").trim()) {
  fail("必须显式提供 DATABASE_URL，拒绝使用应用默认数据库");
}

let slug, tenantName, email, password;
try {
  slug = required("ERP_TENANT_SLUG");
  tenantName = required("ERP_TENANT_NAME");
  email = required("ERP_ADMIN_EMAIL").toLowerCase();
  password = required("ERP_ADMIN_PASSWORD");
} catch (error) {
  fail(error.message);
}
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) fail("ERP_TENANT_SLUG 只能是小写字母、数字或连字符");
if (password.length < 12 || password.length > 128) fail("ERP_ADMIN_PASSWORD 长度必须在 12 到 128 之间");

const pool = createPool();
try {
  const role = process.env.ERP_RUNTIME_ROLE
    || (await pool.query("SELECT current_user AS role")).rows[0].role;
  await migrate(pool, role);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO tenants(id,slug,name) VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING",
      [randomUUID(), slug, tenantName]);
    const tenant = (await client.query("SELECT id FROM tenants WHERE slug=$1", [slug])).rows[0];
    await client.query("INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING",
      [randomUUID(), email, tenantName, await hashPassword(password)]);
    const user = (await client.query("SELECT id FROM users WHERE email=$1", [email])).rows[0];
    await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'admin') ON CONFLICT (tenant_id,user_id) DO NOTHING",
      [tenant.id, user.id]);
    await client.query("COMMIT");
    console.log(`已开通企业「${tenantName}」(标识 ${slug})，管理员 ${email}（角色 admin）。`);
    console.log("初始密码仅保存在你的输入环境变量中，本脚本不会回显；请在首次登录后尽快更换。");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
} catch (error) {
  fail(error.message);
} finally {
  await pool.end().catch(() => {});
}
