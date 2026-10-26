# Mihomo Route Sentinel

面向 Mihomo / Clash Verge Rev 的 AI 业务链路质量守卫与自动故障转移工具。它使用真实业务目标评估整条代理路由，在当前路径连续退化后扫描候选节点、复测、切换并验证；候选验证失败时会隔离该节点并继续尝试，不会直接回到未经复测的故障路径。

本文是安装配置与日常操作的唯一正文来源。项目背景见 [项目说明](PRODUCT.md)，流程和关键取舍见 [工作原理与业务流程](docs/design.md)，已知遗留与下一轮目标见 [迭代计划与遗留问题](docs/iterations.md)。飞书内容由这些文件生成，本轮先作为 Mihomo 样例试行。

## 特性

- Node.js 20+，零第三方依赖。
- Windows 自动发现 Clash Verge 的 Mihomo Named Pipe。
- Linux、macOS、路由器等环境可使用标准 HTTP Controller。
- secret 仅从环境变量读取，不写入配置或日志。
- 区分瞬时异常、部分失败、延迟退化和硬故障。
- 全节点初筛与严格复测使用 Mihomo 组级 delay API，并在 3 秒硬预算内完成独立的两阶段准入。健康期间以较低频率维护候选快照，故障恢复不必重新全局扫描。
- 最短驻留、改善幅度、节点隔离、扫描退避和切换预算避免节点抖动。
- 使用公共对照 URL 识别上游整体故障，避免无意义换节点。
- 记录 HTTPS 的 TLS/TTFB 与 WebSocket 链路指标，结构化日志按大小轮转。
- 配置版本化：兼容无版本的 v1，拒绝未来的不兼容版本。
- Windows 可选客户端进程守卫：服务启动时或运行中发现 Clash Verge 退出，可按退避策略后台恢复。
- Windows 使用隐藏的 Windows Script Host 启动计划任务，后台运行时不显示 Node.js 终端窗口。
- 默认单次 Dry Run；必须显式使用 `--apply` 才会修改节点选择。

## 快速开始

前提：已安装Node.js 20+，Mihomo正在运行，并且你有Controller管理权限。Windows可使用Clash Verge的Named Pipe；其他环境先配置受保护的HTTP Controller。项目没有第三方运行依赖，不需要执行 `npm install`。

首次获取源码，在你希望存放项目的目录执行（已有仓库则进入现有目录，不重复克隆）：

```sh
git clone https://github.com/zhoutianqi613/mihomo-route-sentinel.git
cd mihomo-route-sentinel
node --version
```

下面是Windows PowerShell示例。在Linux/macOS中，用 `cp -n config.example.json config.json` 创建配置，命令路径改用正斜杠；首次也不要传入 `--apply`。

```powershell
if (-not (Test-Path .\config.json)) { Copy-Item .\config.example.json .\config.json }
# 先把 groups.target 和 groups.candidates 两个 CHANGE_ME_* 占位值
# 改为当前 Mihomo 中实际存在的策略组名。
node .\src\cli.mjs --config .\config.json
```

输出 `healthy` 表示当前节点正常。强制扫描但不切换：

```powershell
node .\src\cli.mjs --config .\config.json --force-scan
```

单次检查并允许切换：

```powershell
node .\src\cli.mjs --config .\config.json --apply
```

持续运行：

```powershell
node .\src\cli.mjs --config .\config.json --run --apply
```

查看当前节点、最近健康结果、连续失败、隔离节点、切换预算和遥测摘要：

```powershell
node .\src\cli.mjs --config .\config.json --status
node .\src\cli.mjs --config .\config.json --status-json
```

`--status` 只读 Controller、状态和日志，不获取守护进程锁，不发起探测或切换。

首次成功判据：组名校验通过、Controller可连接，输出本轮真实业务探测结果。`healthy`仅说明当时满足健康门槛，不保证未来网络稳定；`upstream-outage`是启发式判断，不是上游官方故障公告。尚无合格候选时保持/退避可能是正确行为，应结合状态中的原因阅读。

部署注意：`--apply`允许改节点；已启用的运行模式、DNS或进程守卫还可能修正Clash Verge配置、重启或恢复客户端。默认Dry Run只报告预计动作。人工接管前先停止或禁用守护，避免手动选择与后台控制相互覆盖。已有实例运行时，不要再启动第二个守护实例。

## 完整配置参考

以下字段与 `config.example.json` 一一对应。时间字段未特别说明时单位为秒，延迟字段单位为毫秒。

### 根配置与 Controller

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `configVersion` | `7` | 配置格式版本。旧版配置只在内存中迁移，原文件不会被改写。 |
| `controller.transport` | `auto` | Controller 连接方式：`auto`、`http` 或 `pipe`；`auto` 在 Windows 优先发现 Clash Verge Named Pipe。 |
| `controller.url` | `http://127.0.0.1:9090` | HTTP Controller 地址；使用 `http` 时生效，也是 `auto` 无法发现管道时的后备地址。 |
| `controller.pipePath` | 空 | 显式 Named Pipe 路径；留空时按 `pipePattern` 自动发现。 |
| `controller.pipePattern` | `^verge-mihomo-(production\|sidecar-release)-` | 自动发现 Named Pipe 的正则表达式。 |
| `controller.secretEnv` | `MIHOMO_CONTROLLER_SECRET` | Controller 密钥所在的环境变量名；配置文件不保存密钥值。 |
| `controller.requestTimeoutMs` | `5000` | Controller API 单次请求超时。 |

### 代理组

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `groups.target` | 占位符 | Sentinel 实际控制的 Selector，必须替换 `CHANGE_ME_TARGET_SELECTOR`。 |
| `groups.candidates` | 占位符 | 提供可选节点的代理组，必须替换 `CHANGE_ME_CANDIDATE_GROUP`。 |

### 探测与候选准入

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `probes.urls` | ChatGPT、OpenAI API | 真实业务探测 URL 列表，至少两个 HTTP/HTTPS 地址。 |
| `probes.controlUrls` | Cloudflare 204 | 非 OpenAI 对照 URL，用于区分节点故障与上游服务故障。 |
| `probes.timeoutMs` | `5000` | 单次 URL 探测超时。 |
| `probes.discoveryTimeoutMs` | `1200` | 全候选快速发现的单目标超时。本机 58 节点实测约 1.2 秒可返回约 42 个结果；发现阶段优先使用 Mihomo 组级 delay API。 |
| `probes.scanDeadlineMs` | `3000` | 一次候选发现与准入扫描的硬截止，最大允许值为 3000 ms；截止后忽略尚未完成的探测，避免扫描占住健康主循环。 |
| `probes.preSwitchValidationDeadlineMs` | `3000` | 常规切换前对候选池并行复测的总截止时间，最大 3000 ms；不会再按候选数量串行累加。紧急快速复核无可用结果时，也使用此独立窗口再做一轮业务目标复核。 |
| `probes.currentRounds` | `2` | 每周期对当前节点执行的探测轮数。 |
| `probes.currentMinSuccessRate` | `1` | 当前节点健康所需成功率；`1` 表示 100%。 |
| `probes.currentMaxAverageMs` | `800` | 当前节点可接受的平均延迟上限。 |
| `probes.currentMaxSingleMs` | `1500` | 当前节点可接受的单次最大延迟上限。 |
| `probes.scanRounds` | `1` | 初筛每个候选的探测轮数。 |
| `probes.scanUrlCount` | `2` | 初筛使用 `urls` 前 N 个地址；默认同时覆盖 ChatGPT 与 OpenAI API，降低单目标偶然值误导排序的概率。 |
| `probes.validationRounds` | `2` | 候选进入切换前必须连续通过的严格验证轮数。 |
| `probes.topCandidates` | `6` | 保留的首选候选窗口与旧配置兼容字段；v6 在统一硬截止内并发验证至 `maxValidationCandidates`，不再逐批等待。 |
| `probes.maxValidationCandidates` | `18` | 单次扫描最多严格验证的候选总数，避免初筛瞬时抖动把真正稳定的节点排除在前 6 名之外。 |
| `probes.parallelism` | `8` | 故障切前 per-node 复核和组级 API 不可用时的并发节点上限。同一节点的多轮/多 URL 探测串行，不同节点受此值限制；请求共享绝对截止，超时后取消在途 Controller 请求并跳过未启动任务。 |
| `probes.candidateMinSuccessRate` | `1` | 候选准入成功率；默认要求 100%。 |
| `probes.candidateMaxAverageMs` | `600` | 候选准入平均延迟上限。 |
| `probes.candidateMaxSingleMs` | `1200` | 候选准入单次最大延迟上限。 |
| `probes.includeRegex` | 空 | 只允许名称匹配该正则的节点；空表示不限制。 |
| `probes.excludeRegex` | 空 | 排除名称匹配该正则的节点；空表示不排除。 |

### 切换策略

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `policy.intervalSeconds` | `30` | 主健康检查周期；上一轮超时则完成后立即进入下一轮。 |
| `policy.partialFailureCycles` | `2` | 部分请求失败连续达到该周期数后触发候选扫描。 |
| `policy.latencyFailureCycles` | `3` | 纯延迟退化连续达到该周期数后评估切换。 |
| `policy.degradationWindowCycles` | `10` | 统计间歇性延迟退化的滚动周期数，健康周期不会再直接抹掉历史尖峰。 |
| `policy.degradationWindowFailures` | `3` | 滚动窗口内达到该退化次数即触发择优扫描。不得大于窗口周期数。 |
| `policy.optimizationIntervalSeconds` | `900` | 当前节点不是“优秀”时执行周期择优的间隔；`0` 表示关闭周期择优。 |
| `policy.hardFailureConfirmSeconds` | `5` | 硬故障或不可接受尖峰的复核等待时间。 |
| `policy.minimumDwellSeconds` | `120` | 纯延迟优化的最短驻留时间；故障恢复不受此限制。 |
| `policy.minimumImprovementMs` | `200` | 延迟型切换要求候选至少改善的绝对延迟。 |
| `policy.minimumImprovementRatio` | `0.2` | 延迟型切换要求候选至少改善的比例；默认 20%。绝对值与比例满足其一即可。 |
| `policy.failedNodeQuarantineSeconds` | `900` | 失败节点隔离时间。 |
| `policy.maxSwitchAttempts` | `3` | 单次恢复流程最多执行的实际节点切换次数；切前门禁拒绝不会占用次数，服务会继续检查候选池中的后续节点。 |
| `policy.postSwitchDelaySeconds` | `2` | 切换后开始复核前的等待时间。 |
| `policy.postSwitchRounds` | `2` | 切换后新节点必须通过的验证轮数。 |
| `policy.rollbackOnFailure` | `true` | 新节点验证失败时，仅在原节点重新合格后允许回滚。 |
| `policy.emergencySuccessRate` | `0.5` | 成功率小于或等于该值视为硬故障。 |
| `policy.emergencyMaxAverageMs` | `3000` | 平均延迟超过该值视为硬故障。 |
| `policy.immediateMaxSingleMs` | `2500` | 任一次真实探测超过该值即进入快速复核。 |
| `policy.candidateScanBackoffSeconds` | `120` | 没有合格候选后的再次扫描退避。 |
| `policy.switchBudgetCount` | `3` | 滚动窗口内允许的最大切换次数。 |
| `policy.switchBudgetWindowSeconds` | `600` | 切换预算的滚动窗口长度。 |
| `policy.upstreamFailureMinCandidates` | `3` | 至少多少个候选呈现同类业务失败时，可结合对照 URL 判定上游故障并抑制切换。 |
| `policy.candidateSnapshotRefreshSeconds` | `60` | 持续运行时后台刷新候选快照的间隔；刷新使用异步扫描，不阻塞主健康循环，即使切换预算暂时耗尽也可预热后续恢复数据。 |
| `policy.candidateSnapshotMaxAgeSeconds` | `120` | 故障恢复允许复用候选快照的最大年龄；不得小于刷新间隔。默认保留一次刷新失败的容错窗口，过期或选择不匹配时重新扫描。 |
| `policy.emergencySwitchDeadlineMs` | `1000` | 新鲜快照可用时，紧急候选快速复核、决策、配置守卫和 Controller 切换的总 SLO，最大 1000 ms；系统会保留一部分预算给实际切换。快速路径失败后继续有界恢复，超出目标时如实记录 `deadlineMet=false`。 |

延迟等级同时看平均值与单次最大值：优秀为平均不超过 500 ms 且最大不超过 1000 ms；可接受为平均不超过 800 ms 且最大不超过 1500 ms；退化为平均 800–1200 ms 或最大 1500–2500 ms；不可接受为平均超过 1200 ms 或最大超过 2500 ms；硬故障为成功率不超过 50% 或平均超过 3000 ms。平均值不会覆盖尖峰，决策还同时使用成功率、最大值、滚动退化次数、连续周期以及 HTTPS/WebSocket 的 TLS、TTFB 真实链路指标。

周期择优、滚动退化和纯延迟切换优先使用通过严格准入、且相对当前节点至少改善 200 ms 或 20%（满足任一条件）的候选。当前节点已不健康时，若某个复测候选每轮仍满足当前健康线，可作为“临时候选”。当前成功率低于 100% 或进入硬故障且新鲜候选快照可用时，系统不重新全局扫描，而是按快照排名在 1 秒预算内并行快速复核前列节点：有 100% 成功节点时优先选延迟更低者；没有 100% 节点时按本次复核成功率降序、平均/最大延迟升序选择优于当前节点的最佳节点。快照只负责提供候选顺序，不能代替本次可达性证据。快速复核没有相对可用候选时，追加一个 `preSwitchValidationDeadlineMs` 窗口，重新采集一轮全部业务目标样本；单请求超时按目标数分配，给后续目标保留机会。两个窗口的样本不混算，扩大窗口后仍全部为 0% 或没有相对改善才放弃本轮切换。此路径记录 `verificationSource=live-recovery-validation` 和实际一秒目标达成情况，不保证总恢复一秒。紧急接管标记为 `emergency-best-effort`，下一周期必须重新严格准入。周期择优不会为了普通性能优化而使用降级候选。

紧急快速复核只采一轮业务目标；即使已有部分成功，只要最佳候选未覆盖全部目标，也会进入扩大的恢复窗口再比较，避免仅凭短窗口中的局部成功过早消耗切换预算。

### 日志与真实链路遥测

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `logging.maxBytes` | `5242880` | 单个 NDJSON 日志文件达到该字节数后轮转。 |
| `logging.retainedFiles` | `14` | 保留的轮转日志份数。 |
| `telemetry.enabled` | `true` | 是否额外检测经本地代理访问 HTTPS 与 WebSocket 的真实链路。 |
| `telemetry.proxyUrl` | `http://127.0.0.1:7897` | 遥测使用的本地 HTTP 代理地址，应与客户端监听端口一致。 |
| `telemetry.httpsUrl` | `https://chatgpt.com/` | HTTPS/TLS/TTFB 遥测目标。 |
| `telemetry.websocketUrl` | Codex Responses WebSocket | WebSocket 握手遥测目标。 |
| `telemetry.timeoutMs` | `5000` | 每项遥测超时。 |

### 配置与客户端进程守卫

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `guardrails.enabled` | `true` | 是否启用运行模式、客户端进程及 DNS 覆写守卫。关闭后不执行这些检查或修复。 |
| `guardrails.autoRepair` | `true` | 是否实际执行自动纠正；`false` 时只报告 `would-repair` 并阻止切换。 |
| `guardrails.expectedRuntimeMode` | `rule` | 期望 Mihomo 模式，只允许 `rule` 或 `global`；禁止把 `direct` 作为目标模式。 |
| `guardrails.runtimeModeCheckIntervalSeconds` | `5` | 独立守卫检查周期，同时用于发现客户端被关闭。 |
| `guardrails.ensureClashVergeRunning` | `false` | Windows 可选进程守卫。设为 `true` 后，服务启动时或运行中发现 Clash Verge 未运行，会后台启动它；准备主动退出客户端前应先停止 Sentinel 或关闭本项。 |
| `guardrails.clashVergeExecutable` | 空 | Clash Verge 可执行文件的可信绝对路径；启用进程守卫时必填且文件名必须是 `clash-verge.exe`。已运行进程路径不一致时拒绝重复启动。 |
| `guardrails.clashVergeStartBackoffSeconds` | `30` | 启动失败或超时后的最短重试间隔，避免持续拉起进程。 |
| `guardrails.clashVergeStartupTimeoutSeconds` | `20` | 启动后等待 Controller 恢复的最长时间；超时则保持故障关闭并进入退避。 |
| `guardrails.disableClashVergeDnsOverride` | `true` | 是否检查当前订阅的 DNS 覆写，并在发现错误开启时自动关闭。 |
| `guardrails.clashVergeAppDir` | 空 | Clash Verge 应用数据目录。Windows Named Pipe 模式可留空自动发现；HTTP Controller、Linux 和 macOS 需填写绝对路径才检测 DNS 覆写。 |
| `guardrails.restartClashVergeOnDnsRepair` | `true` | Windows 修复 DNS 覆写后是否隐藏重启 Clash Verge，使持久化修改进入运行态。 |

进程守卫只在 Windows 上执行，不会杀死或强制重启一个已经运行的正常客户端。若启动文件缺失、运行进程路径与配置不符、启动失败或 Controller 未在超时内恢复，Sentinel 会保持 `blocked`，停止探测与切换，并按退避时间重试。开源默认关闭此功能，避免用户主动退出客户端时被意外拉起。

若 Clash Verge 恰好在健康探测期间退出，本轮 Controller 请求可能中断；持续运行模式会立即经过同一守卫队列恢复客户端，将该轮记录为 `watchdog-cycle-interrupted-by-client-restart`，下一周期继续检查，而不是把已恢复的退出误报为持续故障。

### 状态文件

所有相对路径都以 `config.json` 所在目录为基准；从其他目录运行时，应优先用 `--status` 输出的绝对日志路径。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `files.state` | `./var/state.json` | 健康周期、节点准入、隔离和切换预算状态文件。 |
| `files.log` | `./var/watchdog.ndjson` | 结构化运行日志；在配置目录中可用 `Get-Content .\\var\\watchdog.ndjson -Wait` 实时查看。 |
| `files.lock` | `./var/watchdog.lock` | 单实例锁文件，防止重复守护进程同时切换。 |
| `files.guardrailState` | `./var/guardrails.json` | DNS 已修改但尚未确认重载的持久债务；只有运行态复核成功才会清除。 |

配置在启动时严格校验：轮数、并发数、周期和预算必须是整数，成功率必须在 0–1 内，正则必须可编译，业务探测 URL 只允许 HTTP/HTTPS，遥测 URL 必须匹配各自协议。无效配置会在连接 Controller 或切换节点前终止。

## 配置守卫与自动纠正

每个监控周期都会先执行配置守卫，再进行链路探测和节点切换：

1. 可选的 Windows 客户端进程守卫先检查同一用户会话中的 `clash-verge.exe`；未运行时按配置的可信路径隐藏启动，并等待 Controller 恢复。启动失败会进入退避，不会高速重试。
2. 每个主周期读取 Mihomo `/configs`；独立守卫还会按 `runtimeModeCheckIntervalSeconds` 检查。运行模式被人为切成 `direct` 时立即改回配置的 `rule` 或 `global` 并复核。
3. 运行模式只通过 Mihomo 官方 API 修复，不读取或重写可能包含节点与凭据的 `config.yaml`；Clash Verge 重启后会再次纠正。
4. 检查当前订阅的 DNS 覆写状态；Windows 仅定位需要关闭的布尔字段，在停止同一会话的 Clash Verge 后原位修改，不生成包含其他配置的临时副本。
5. 隐藏重启 Clash Verge 后，同时复核持久化开关、生成配置已刷新、Controller 恢复和运行模式；本周期暂停节点切换。
6. DNS 重载债务写入独立状态文件，跨周期和服务重启保留。任何修复或复核失败都会持续进入 `blocked`，停止探测和切换。

默认单次命令是 Dry Run：只报告 `would-repair`，不会修改 Mihomo 或 Clash Verge。计划任务使用 `--apply`，会自动修复。`--status` 分别显示“客户端进程守卫”和“配置守卫”的最近状态、问题与修复结果。

Windows 可自动完成上述 DNS 修复闭环。Linux 和 macOS 只有显式配置 `guardrails.clashVergeAppDir` 时才检测，且当前不修改第三方配置；发现 DNS 覆写时保持 `blocked` 并给出问题代码。

## 自动切换策略

正常模式按 30 秒固定起始节拍检查，每轮对 ChatGPT 和 OpenAI API 各探测两次。持续运行期间默认每 60 秒在单实例异步通道刷新候选快照；当前节点探测通道不会等待扫描。故障确认后优先复用 120 秒内且与当前选择匹配的快照，允许一次刷新失败时继续快速恢复；缓存缺失或过期时才重新扫描，因此冷启动首次故障不承诺 1 秒恢复。

| 状态 | 判定 | 动作 |
|---|---|---|
| 健康 | 4/4 成功、平均延迟不超过 800 ms、单次不超过 1500 ms | 保持当前节点 |
| 瞬时异常 | 尚未达到对应的连续周期阈值 | 记录，不切换 |
| 部分失败 | 成功率高于 50% 但低于 100%，连续 2 个周期 | 立即扫描和切换，不受最短驻留限制 |
| 延迟退化 | 100% 成功，但平均或单次延迟超标，连续 3 个周期 | 最短驻留结束后，仅切换到至少改善 200 ms 或 20% 的候选 |
| 间歇性退化 | 最近 10 个周期累计 3 次延迟退化或尖峰 | 达到第 3 次的当周期触发择优扫描，仍遵守最短驻留与改善门槛 |
| 周期择优 | 当前节点健康但未达到“优秀”，且距离上次择优已满 15 分钟 | 扫描严格合格候选，仅在改善至少 200 ms 或 20% 时切换；配置为 `0` 可关闭 |
| 不可接受尖峰 | 任一真实探测超过 `immediateMaxSingleMs`（默认 2500 ms），但尚未达到硬故障 | 5 秒后确认；仍为尖峰则立即扫描，不受普通连续周期与最短驻留限制 |
| 硬故障 | 成功率不超过 50% 或平均延迟超过 3000 ms | 5 秒后确认；仍失败则立即扫描，不受普通连续周期与最短驻留限制 |

候选必须 100% 成功、平均延迟不超过 600 ms、单次不超过 1200 ms，并连续两轮验证合格。常规切换前会在统一 3 秒截止内并行复测整个候选池，不再逐节点串行等待；门禁失败的节点不消耗切换预算或 `maxSwitchAttempts`。紧急降级先尝试一秒快速路径，失败后继续最多 3 秒的恢复复核，切换后标记为待严格准入而不会伪装成已验证节点。普通切换仍会切后验证两轮；失败候选隔离 15 分钟并继续尝试下一个。找不到有收益的候选后退避 120 秒；10 分钟最多切换 3 次。业务目标整体失败但对照 URL 正常时，按上游故障处理并抑制切换风暴。

快速路径使用 Mihomo 组级 delay API：默认初筛为 `1 轮 × 2 URL`，严格复测独立执行 `2 轮 × 2 URL`，保持两阶段准入的独立性。实机验证表明，在初筛后的剩余约 1.8 秒内批量 per-node 复测无法可靠得到严格候选，因此它只用于故障切前的小候选池快速复核和组级 API 不可用时的受控降级，不用于生成后台严格快照。全流程共享 `scanDeadlineMs=3000` 硬截止，Controller 请求支持取消；快照刷新由 30 秒降至 60 秒，使健康期全组探测量约降低一半。状态输出会显示初筛与复测的 Controller 请求数、估算节点测试数和峰值并发。健康期结果被压缩为不含地址和凭据的候选快照；快照与当前 Selector/叶子不匹配或超过最大年龄即失效。

扫描使用同一 Node.js 服务内的异步 I/O 通道，而不是操作系统子进程。网络探测不是 CPU 密集任务；子进程会额外引入 Controller 凭据传递、Named Pipe 重连、日志合并、取消和孤儿进程清理问题。健康检查、后台快照刷新和候选并行复核相互隔离；真正修改路由的 `select` 仍严格串行且单实例。

如果用户或其他程序在 Sentinel 之外改变目标 Selector，或嵌套代理组解析出的实际叶子节点发生变化，实际选择会与最近已准入状态比对并记录 `external-selection-detected`。新节点必须使用业务 URL 按候选门槛立即完成严格多轮准入；未通过时立即扫描其他候选，并把待准入状态保留到成功准入或 Sentinel 完成切换。Mihomo UI 中的 `5000 ms` history/占位显示不参与准入判断。

如果用户把目标 Selector（例如 `XFLTD`）改成“自动选择”等嵌套代理组，而其当前叶子也是目标组的直接可选成员，Sentinel 会先把目标组固定到当时的真实叶子，消除验证期间自动组继续漂移的竞态；这不会改变当时的实际出口。固定叶子会被标记为待严格准入，下一周期按候选门槛验证；不合格时进入候选恢复流程。对于叶子不是目标组直接成员的合法嵌套拓扑，Sentinel 继续执行原有严格准入和动态叶子监控，但不会进行无法安全验证的结构改写。Dry Run 只报告 `would-normalize-nested-selection`，不会修改选择。纠正日志为 `nested-selection-normalized`，`--status` 的“最近代理组纠正”会显示最近一次自动修正。

升级到包含节点准入版本的版本后，缺少 `selectionAdmissionVersion` 的旧状态会对当前 Selector 和叶子节点执行一次严格基线复核，并记录 `baseline-revalidation`；这不是本轮检测到外部切换。通过后写入版本，未通过则保留待准入状态并寻找合格候选。Sentinel 自身完成验证切换时也会写入同一版本，避免旧状态或中断切换被静默继承。

延迟质量等级用于日志解释和产品判断，不单独替代成功率与连续周期：

| 等级 | 延迟范围 |
|---|---|
| 优秀 | 平均不超过 500 ms，最大不超过 1000 ms |
| 可接受 | 平均不超过 800 ms，最大不超过 1500 ms |
| 退化 | 平均 800–1200 ms，或最大 1500–2500 ms |
| 不可接受 | 平均超过 1200 ms，或最大超过 2500 ms |
| 硬故障 | 成功率不超过 50%，或平均超过 3000 ms |

平均值可能掩盖尖峰，因此决策同时使用成功率、平均值、最大值、抖动和连续周期。HTTPS 遥测分解 TCP/TLS/TTFB/总时长，WebSocket 遥测检查握手。遥测用于运维观测，当前不替代候选节点的多轮准入门槛。

HTTP Controller 使用 secret 时，只配置环境变量名称：

```json
{
  "controller": {
    "transport": "http",
    "url": "http://127.0.0.1:9090",
    "secretEnv": "MIHOMO_CONTROLLER_SECRET"
  }
}
```

然后在安全的系统凭据环境中设置 `MIHOMO_CONTROLLER_SECRET`，不要把真实值写进 JSON。

## Windows 后台运行

安装当前用户登录时启动的计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

使用 BAT 脚本管理服务：

```powershell
:: 立即启动
.\scripts\service-windows.bat start

:: 停止当前进程并清理本项目残留的 node.exe
.\scripts\service-windows.bat stop

:: 重启
.\scripts\service-windows.bat restart

:: 停止并禁用登录自启
.\scripts\service-windows.bat disable

:: 恢复登录自启（不会立即启动）
.\scripts\service-windows.bat enable

:: 查看状态
.\scripts\service-windows.bat status
```

`start` 或 `restart` 不会隐式启用已禁用的任务；需要先执行 `enable`。脚本默认管理
`MihomoRouteSentinel`，也可通过 `-TaskName` 管理自定义安装名称。

BAT 是公开入口，内部 PowerShell 仅负责调用 Windows 计划任务 API、精确核验 PID 和清理锁文件。`stop` 只结束命令行包含本项目 `src\cli.mjs` 完整路径的 Node.js 进程，不会批量结束其他 Node.js 程序。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1
```

## Linux systemd

安装器参数依次为“项目绝对路径、配置绝对路径、运行用户”；省略时使用当前项目、项目内 `config.json` 和 `sudo` 发起用户：

```sh
sudo sh ./scripts/install-linux.sh /opt/mihomo-route-sentinel /opt/mihomo-route-sentinel/config.json mihomo
sudo sh ./scripts/service-unix.sh start
sudo sh ./scripts/service-unix.sh status
```

如果 Controller 需要 secret，由管理员在 `/etc/mihomo-route-sentinel.env` 中设置对应环境变量并限制文件权限；安装器不会读取或写入 secret。

HTTP Controller 必须只监听受信任接口，并通过防火墙或 secret 保护。

## macOS launchd

macOS 使用当前用户的 LaunchAgent，不会打开终端窗口：

```sh
sh ./scripts/install-macos.sh /Users/me/mihomo-route-sentinel /Users/me/mihomo-route-sentinel/config.json
sh ./scripts/service-unix.sh status
```

如果 macOS Controller 需要 secret，应由 MDM、Keychain 辅助程序或其他组织批准的凭据注入机制，将 `controller.secretEnv` 指定的环境变量注入当前 `gui/<uid>` launchd 域。不要把 secret 写入 plist、JSON 或命令历史。

Linux 和 macOS 共用以下管理命令：

```sh
sh ./scripts/service-unix.sh start
sh ./scripts/service-unix.sh stop
sh ./scripts/service-unix.sh restart
sh ./scripts/service-unix.sh disable
sh ./scripts/service-unix.sh enable
sh ./scripts/service-unix.sh status
```

`disable` 会同时停止实例，`enable` 只恢复自启权限而不主动启动。Linux 需要有权限管理 systemd；macOS 管理当前用户的 `gui/<uid>` LaunchAgent。

> 边界：本轮已在 Windows 上完成 shell/plist/unit 的文本与命令覆盖检查，但当前机器无 systemd 和 launchd，因此 Linux/macOS 的安装、权限与启停仍需在目标系统做一次实机验收。

## 运行文件

- `var/state.json`：当前节点、连续失败、后台扫描状态、最近扫描/切换、隔离节点和滚动切换预算。Dry Run 不写此文件。
- `var/watchdog.ndjson`：结构化运行日志，包含健康结果和 TLS/TTFB/WebSocket 指标，不记录 controller secret 或节点服务器地址。达到 `logging.maxBytes` 后轮转，保留 `logging.retainedFiles` 份。
- `var/watchdog.lock`：防止重复实例。
- `var/guardrails.json`：保存 DNS 修复后的待重载/待复核债务，问题确认解决后自动清除。

Windows 的 `service-windows.bat status` 以及 Unix 的 `service-unix.sh status` 用于查看服务层状态；业务状态使用 CLI `--status` 或便于机器处理的 `--status-json`。状态会显示后台进程实际写入的程序版本、PID 和启动时间，用于识别任务虽为 Running 但仍加载旧代码的情况；同时展示后台扫描状态、扫描耗时、3 秒截止是否触发，以及严格/临时候选。候选快照刷新完成后会立即清除 `running`；常规并行门禁最多 3 秒，紧急切换日志额外记录 `decisionDurationMs` 与 `deadlineMet`。

## 开源许可

本项目采用 [MIT License](./LICENSE)。

## 产品审查 Agent

- `agents/product-manager.md`：可复用的产品经理 Agent 角色、检查维度和输出契约。
- `docs/product-review-2026-10-23.md`：历史独立审查结论；其中参数和建议只代表当时版本，当前策略见本手册，当前遗留与计划见 [迭代记录](docs/iterations.md)。
