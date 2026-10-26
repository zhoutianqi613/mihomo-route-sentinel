# Mihomo Route Sentinel

## Scope

- Build a reusable, dependency-free AI route quality sentinel and automatic failover service for Mihomo-compatible controllers.
- Support Windows Clash Verge named pipes and standard HTTP controllers.
- Keep runtime configuration in JSON and credentials only in environment variables.

## Constraints

- Require Node.js 20 or newer and use only built-in modules.
- Never read, persist, or log subscription URLs, node server addresses, controller secrets, tokens, or credentials.
- Probe real configured service targets and switch only after repeated failures and candidate validation.
- Prevent flapping through consecutive-failure thresholds, cooldowns, and minimum quality gates.
- Default to dry-run-safe behavior until the user explicitly runs continuous mode without `--dry-run`.

## 文档维护试行（仅本项目）

- 本次开发影响产品范围、操作、控制流程或阶段结果时，在同一交付中更新 `PRODUCT.md`、`README.md`、`docs/design.md` 或 `docs/iterations.md` 对应正文；无影响时说明理由。不要额外生成空模板或重复摘要。
- 仓库是四篇正文的唯一编辑源；飞书Backlog是任务状态的唯一来源。飞书文档是发布快照，不要求Bear双写。
- 先运行 `npm run docs:check` 与 `npm run docs:publish` 预览。用户已授权本次飞书同步时才执行 `npm run docs:publish -- --apply`；未授权或同步失败时明确报告未发布，不把本地完成说成线上完成。
- 发布只允许固定四页与本项目文档同步日期；远端手改、评论或版本漂移时停止覆盖。不得因此重启服务、切换代理、自动提交或推送Git。
- 这仍是Mihomo样例，待Bear确认；不得自动推广到其他项目。

## Verification

- Run `npm test`.
- Run a dry-run one-shot check against the current Mihomo controller.
- Validate JSON configuration and confirm no secrets are present in tracked files.
