-- 企业开通：允许在事务的租户上下文内创建成员。
--
-- 040 迁移给 memberships 打开了 FORCE RLS，但只定义了读取与更新策略，
-- 因此"新建企业成员/开通首个管理员"在数据库层被拒绝。这里补上 INSERT 策略，
-- 范围与更新一致：只能写入当前事务 app.tenant_id 指向的租户。
CREATE POLICY membership_tenant_insert ON memberships
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
