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

## 文档维护（发布范围仅本项目）

- 本次开发影响产品范围、操作、控制流程或阶段结果时，在同一交付中更新 `PRODUCT.md`、`README.md`、`docs/design.md` 或 `docs/iterations.md` 对应正文；无影响时说明理由。不要额外生成空模板或重复摘要。
- 仓库是四篇正文的唯一编辑源；飞书Backlog是任务状态的唯一来源。飞书文档是发布快照，不要求Bear双写。
- 先运行 `npm run docs:check` 与 `npm run docs:publish` 预览。用户已授权本次飞书同步时才执行 `npm run docs:publish -- --apply`；未授权或同步失败时明确报告未发布，不把本地完成说成线上完成。
- 发布只允许固定四页与本项目文档同步日期；远端手改、评论或版本漂移时停止覆盖。不得因此重启服务、切换代理、自动提交或推送Git。
- Bear已批准本版式并授权推广至Mahjong Assistant和Project Search MCP；本仓库发布器仍只操作本项目，不因此扩大发布权限。公共展示层由 `../../tools/portfolio-docs` 维护，经同步工具生成仓库内模块，避免三份排版手工漂移。

## 文档可读性与交付状态

- **事实优先：** 重排必须保留条件、阈值、配置字段、有效命令、副作用和证据边界；不能为缩短文字而删掉例外、否定条件或未完成事项。正文以读者要完成的任务组织。
- **段落长度：** 一段只讲一个主题，建议60—120个可见字符，普通段落及列表阅读块不得超过180个可见字符。连续非空行仍视为同段，不能靠源码换行绕过；代码块、链接目的地址和代码标识符不计入普通字数。
- **目录结构：** 首页保留6个主章节，子页保留4—5个主章节；正文只使用 `## 01 主章` 与 `### 1.1 二级目录` 两级导航，禁止四级及更深标题。二级标题使用4—8字名词短语，必要专有名词例外；同章编号必须从1开始且连续，实际标题不再重复平台自动编号。
- **信息归位：** 手册第04章只定义配置字段、默认值、单位、取值约束、必要示例和直接副作用；完整判决规则归工作原理页，运行现象与处置入口归手册第05章。每类事实保留一个完整维护位置，其他位置用链接引用。
- **平台与步骤：** 在线部署章节以平台作为三级标题，平台内部操作使用短粗体组标签，避免父子主题同级。历史版本、配置字段和许可资料同样使用短粗体标签，不形成隐藏的第三层目录。跨代码块的操作采用显式“第N步”标签，避免飞书重置列表编号。
- **关键字段：** 列表中的“原问题、主要变化、本地证据、投用证据、后台观察、限制”等首标签，统一写成 `**标签：**`；关键结论和动作条件短加粗，参数/命令/状态标识符用代码样式。禁止整段加粗或为普通正文使用花体、任意字号。
- **颜色语义：** 常规正文使用默认深色；说明用浅蓝提示块，风险/限制用浅橙提示块。每块只表达一件事、保持简短；彩色文字仅用于少量短语，不整段染色，不能只靠颜色区分含义。
- **表达选择：** 操作按3—7步拆分；比较用2—3列短表，每格尽量不超过120个可见字符；复杂流程优先图加短步骤，图旁必须说明读法。长证据、例外和版本详情放表后，不把一段长文搬进单元格。概览仍为“版本｜阶段｜主要变化”三列。
- **命令与留白：** 命令必须可复制执行；长命令使用对应Shell有效续行。标题、正文、列表、表格与代码块之间保留空行；高风险动作的副作用提示应紧邻操作，不与普通说明混写。
- **完成状态：** 交付记录必须明确区分已完成、部分完成/待验收、后续未实施。自动化、假Controller故障注入、只读实机、真实切换与长期观察分别说明；本地投用不等于正式Release，不能把P1/P2未来计划列成当轮完成成果。
- **职责与验收：** 内容编辑保全事实，信息设计负责层级/组件，测试角色检查语义与实际呈现，项目经理逐项审核。退回须说明原因、复验后关闭，收尾反馈全部退回项。`docs:check`应检查阅读块长度、两级编号目录、配置覆盖、图示白名单及发布保护；发布后读回标题/加粗标签，并抽查真实网页或飞书导出的实际版式。
- **作用范围：** 本轮新增规则先落在Mihomo正文与本项目展示层；不得手改公共生成物或自动把新规则推广至其他项目。飞书的四个既有节点保持不变，只有已授权的正文发布和本项目同步日期可修改。

## Verification

- Run `npm test`.
- Run a dry-run one-shot check against the current Mihomo controller.
- Validate JSON configuration and confirm no secrets are present in tracked files.
