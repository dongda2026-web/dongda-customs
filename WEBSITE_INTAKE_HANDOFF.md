# 官网接单协作边界

2026-10-10 用户明确授权官网会话负责本工作树的专用官网接收模块及最小共享接线。

- 官网来源工作树：`../dongda-website-delivery`。
- 官网会话拥有：`src/website-intake.js`、`src/migrations/010-website-intake.sql`、`tests/website-intake.test.mjs`。
- 共享接线仅涉及 `src/app.js` 接收/来源路由、`src/db.js` 新表最小授权、`server.js` 私有配置传入；不覆盖已有修改，不改订单、采购、库存的业务实现。
- 路由：`POST /api/v1/integrations/website-inquiries`；专用服务 token 的 SHA256 映射固定 tenantId/siteId/ownerId；无浏览器会话权限。
- 原始询盘与现有 `leads` 同事务；来源表 RLS、唯一键及只读原始需求，ACK 使用真实 UUID；官网按 `four-modules-v1` 明确选择此协议。
- `/api/v1/leads/:id/website-source` 由员工会话读取，限制角色、租户及负责人；不得公开读取或通过通用 CRUD 修改原始来源。
- ERP 未落库不返回 persisted。未配置、owner 不可用或生产未接通明确失败；不把模拟 ACK 算端到端完成。
- CMS、附件、官方社媒连接及生产部署不因本接线自动启用。

## 员工页面归属（用户最新确认）

2026-10-10用户选择“由另一ERP会话负责”：ERP员工页原始需求展示、来源关联及完整接单浏览器验收由四模块前端会话承担；官网会话不修改`public/erp*`页面或脚本。本会话继续官网表单、发送和接收合同验证。

## 已实现接口

- 员工会话：`GET /api/v1/leads/{leadId}/website-source`。
- 返回：`{siteId,sourceInquiryId,schemaVersion,receivedAt,payload}`。没有来源时404，非GET为405；admin/auditor可读本租户，sales/social仅可读当前归属线索，warehouse等角色拒绝。
- 任何非2xx不得作为空需求或旧缓存正常呈现；重新分配、退出和切换租户后必须清除旧详情，迟到响应不能覆盖新身份。
- payload含普通联系与需求字段；RFQ使用独立items，定制使用quote根或RFQ行customization；样品使用sampleRequest，quantity与预计采购量独立。字段只读，不通过PATCH来源保存。
- 线索仍走现有`/leads/{id}`；跟进走`/leads/{id}/followups`；明确客户绑定走线索PATCH，携带version。报价关联lead_id，确认接受再转单，使用现有幂等命令，不新建第二套销售流程。
- 不匹配客户名称猜测partner_id，不按官网产品ID直接填写内部product_id，不把样品数量或自由文本自动变成正式订单。

## 前端验收清单

- [x] 合成员工通过真实登录后，从线索进入只读官网来源，显示DD回执、站点、收件时间和请求类型。
- [x] 普通、AI客服、RFQ、定制、样品原始内容完整展示；未知键和值用textContent，不能注入HTML。
- [x] 样品数量与预计采购量独立展示，定制尺寸保留cm及规格中的mm，RFQ每行独立数量和规格。
- [ ] 非owner、跨租户、warehouse、退出后不可读取；变更归属或身份后旧内容立即清理。
- [x] 404、403、503及网络失败各有明确状态，不显示“已处理”或旧缓存成功。404按服务端防枚举语义显示“无官网来源或无权查看”，不猜测是否存在。
- [ ] 跟进及客户绑定有版本冲突保护；失败保留用户编辑而不覆盖他人更新。
- [x] 报价关联原线索，明确接受后才创建订单；提交后丢回执重试同一命令只生成一单，订单能沿quote→lead→source追溯。双击独立压力测试尚未穷尽。
- [x] 中英俄原始需求×五类型×390/1440共30组真实浏览器展示；来源入口键盘Enter可用，ERP无localStorage/sessionStorage写入。这是多语言内容展示，不是ERP界面三语翻译完成。

### ERP员工页回交（2026-10-10）

新增 `public/erp/website-source.js`，不修改官网拥有的接收器、迁移或网站业务代码。来源只读，客户需先明确绑定，内部商品及正式数量初始空白；报价创建在服务端锁定线索并验证客户匹配，来源单据禁止修改成另一客户。

已通过本地真实程序链路：官网四类真实表单→SQLite收件→显式运行真实CRM发送→ERP PostgreSQL→员工查看原始需求/跟进/绑定客户/报价/接受转单→订单回查来源。原始来源与SQLite内容前后比对，通知仍为pending，不涉及生产。完整集成测试要求显式 `DONGDA_WEBSITE_TEST_ROOT`，缺少时该测试跳过，不冒充联调通过。

未勾选项的实际边界：
- 权限接口实测拒绝非owner、跨租户、warehouse和已退出会话；客户端在切换记录/刷新/退出/隐藏页面时清空，重新聚焦和重新查看时核验权限。未建立服务端撤权推送，不能声称另一个员工改负责人瞬间清除正在前台展示的页面。
- 客户绑定并发409保留本地编辑且不覆盖服务端；跟进提交后丢ACK重试已通过。跟进同时被另一员工修改的专门浏览器冲突用例尚待补。
- 官网界面四类跨系统流程为桌面实际操作，手机来源展示已覆盖；不能将其扩大为全网站/ERP全部功能在三语手机上的完整验收。

## 可复验的后端证据

官网目录运行`DONGDA_ERP_TEST_ROOT=/absolute/path/to/dongda-erp-four-modules node --test tests/four-modules.integration.mjs`。
前序真实HTTP/SQLite/PG四组通过，包含五种需求、丢ACK重投、独立SQLite备份恢复、现有员工API跟进/报价/幂等转单。员工页续接已按上述边界完成本地验证；最新计数以PROJECT_LOG及根目录《东大制单-四模块执行进度.md》为准。
