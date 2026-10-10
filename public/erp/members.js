import { esc, field, button, openEditor, notice } from "./ui.js";

export const memberRoles = { admin: "企业管理员", sales: "销售", social: "社媒运营", purchasing: "采购", warehouse: "仓管", auditor: "审计" };
const errors = {
  LAST_ADMIN: "必须至少保留一位有效的企业管理员，请先完成管理员交接。",
  VERSION_CONFLICT: "成员权限已被其他管理员修改。请保留操作原因，关闭并刷新后核对，不会覆盖最新权限。",
  ACCOUNT_DISABLED: "全局账号已停用，本企业管理员不能恢复全局账号。",
};
export function mountMember(body, actions, { row, userId, mutation, changed, signOut, current }) {
  const facts = [
    ["邮箱", row.email], ["本企业角色", memberRoles[row.role]], ["本企业状态", row.active ? "启用" : "停用"],
    ["全局账号", row.account_active ? "有效" : "已停用"], ["权限版本", row.version],
  ];
  body.innerHTML = `<dl class="facts">${facts.map(([label, value]) =>
    `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    <p class="summary-note">仅管理已有成员在本企业的权限，不修改其他企业授权、邮箱或密码。邀请新成员与账号恢复尚未开放。</p>
    <p class="summary-note">权限变更或撤销会话后，该成员须重新登录。正在处理的业务事务先结束，撤权提交后的新请求拒绝旧会话；页面在下次请求时清除数据。</p>`;
  function edit(revoke) {
    if (!current()) return;
    const self = row.id === userId, key = crypto.randomUUID();
    const html = (revoke ? "" : field("role", "本企业角色", row.role, {
      options: Object.entries(memberRoles).map(([value, label]) => ({ value, label })),
    }) + field("active", "本企业状态", String(row.active), {
      options: [{ value: "true", label: "启用" }, { value: "false", label: "停用" }],
    })) + field("reason", "操作原因", "", { type: "textarea", full: true })
      + `<p class="full summary-note">${self ? "当前操作对象是您本人。变更生效后将退出当前会话，请确认交接安排。" : "生效后撤销该成员在本企业的全部已有会话，其他企业不受影响。"}</p>`;
    openEditor(revoke ? "撤销本企业会话" : "调整成员权限", html, async values => {
      if (!current()) throw new Error("当前成员详情已改变，请关闭后重新选择成员。");
      let result;
      try {
        result = await mutation(`/members/${row.id}${revoke ? "/revoke-sessions" : ""}`, revoke ? "POST" : "PATCH",
          { version: row.version, reason: values.reason, ...(revoke ? {} : { role: values.role, active: values.active === "true" }) }, key);
      } catch (error) { throw new Error(errors[error.code] || error.message); }
      if (self && result.version !== row.version) {
        signOut();
        return;
      }
      if (!current()) return;
      await changed();
      notice(revoke ? "本企业已有会话已撤销" : "成员权限已保存");
    });
  }
  actions.append(button("调整成员权限", () => edit(false)), button("撤销本企业会话", () => edit(true)));
}
