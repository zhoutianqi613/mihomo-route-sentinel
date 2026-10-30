# Mihomo Route Sentinel

面向 Mihomo / Clash Verge Rev 的 AI 业务链路守护程序与自动故障转移工具。它使用真实业务目标评估代理路由，按异常类型确认后复核候选并受约束地恢复；候选验证失败时会隔离该节点并继续尝试，不会直接回到未经复测的故障路径。

本文是安装配置与日常操作的唯一正文来源。项目背景见 [项目说明](PRODUCT.md)，流程和取舍见 [工作原理与业务流程](docs/design.md)，已知遗留与下一轮目标见 [迭代计划与遗留问题](docs/iterations.md)。飞书阅读副本由仓库正文生成。

> [!NOTE]
> **先只读验证，再允许控制。** 按首次运行、日常操作、后台部署、配置字段和状态判读的顺序查阅。

<!-- sentinel:cards -->
| 步骤 | 动作 |
|---|---|
| ① 准备环境 | 获取源码，确认 Controller 可达 |
| ② 只读验证 | 填写组名，运行单次 Dry Run |
| ③ 允许控制 | 理解副作用后再开启守护 |
<!-- sentinel:/cards -->

**能力清单：**

- **运行依赖：** Node.js 20+，零第三方依赖。
- **Windows 连接：** 自动发现 Clash Verge 的 Mihomo Named Pipe。
- **跨平台连接：** Linux、macOS、路由器等环境可使用标准 HTTP Controller。
- **凭据保护：** secret 仅从环境变量读取，不写入配置或日志。
- **故障分级：** 区分瞬时异常、部分失败、延迟退化和硬故障。
- **候选探测：** 全部使用逐节点 delay API。后台完成发现与短名单严格复测，并维护快照；前台使用独立有界发现和实时复核，不等待后台慢扫描。
- **抖动抑制：** 使用最短驻留、改善幅度、节点隔离、扫描退避和切换预算。
- **上游识别：** 使用公共对照 URL 识别整体故障，避免无意义换节点。
- **链路观测：** 记录 HTTPS 的 TLS/TTFB 与 WebSocket 指标，结构化日志按大小轮转。
- **配置版本：** 兼容无版本的 v1，拒绝未来的不兼容版本。
- **客户端守卫：** Windows 可选；启动时或运行中发现 Clash Verge 退出，按退避策略后台恢复。
- **后台隐藏：** Windows 通过隐藏的 Windows Script Host 启动计划任务，不显示 Node.js 终端窗口。
- **默认只读：** 默认单次 Dry Run；必须显式使用 `--apply` 才会修改节点选择。

## 01 首次运行

### 1.1 环境与权限

**前提：** 已安装 Node.js 20+，Mihomo 正在运行，并且你有 Controller 管理权限。项目没有第三方运行依赖，不需要执行 `npm install`。

**连接方式：** Windows 可使用 Clash Verge 的 Named Pipe；其他环境先配置受保护的 HTTP Controller。

### 1.2 配置与组名

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
```

### 1.3 单次检查

**首次成功判据：** 组名校验通过、Controller 可连接，并输出本轮真实业务探测结果。首次命令默认 Dry Run，只报告预计动作。

```powershell
node .\src\cli.mjs --config .\config.json
```

强制扫描但不切换：

```powershell
node .\src\cli.mjs --config .\config.json --force-scan
```

### 1.4 结果判读

| 输出或行为 | 如何理解 |
|---|---|
| `healthy` | 当前节点当时满足健康门槛；不保证未来网络稳定。 |
| `upstream-outage` | 启发式判断，不是上游官方故障公告。 |
| 保持当前节点或退避 | 尚无合格候选时可能是正确行为；结合状态中的原因判断。 |

## 02 日常操作与人工接管

### 2.1 持续观察

保持默认 Dry Run，只持续观察和记录预计动作：

```powershell
node .\src\cli.mjs --config .\config.json --run
```

### 2.2 状态查看

查看当前节点、最近健康结果、连续失败、隔离节点、切换预算和遥测摘要：

```powershell
node .\src\cli.mjs --config .\config.json --status
node .\src\cli.mjs --config .\config.json --status-json
```

`--status` 只读 Controller、状态和日志，不获取守护进程锁，不发起探测或切换。

### 2.3 路由控制

> [!WARNING]
> **实际副作用：** `--apply` 允许修改节点选择。已启用的运行模式、DNS 或进程守卫还可能修正 Clash Verge 配置、重启或恢复客户端。

单次检查并允许切换：

```powershell
node .\src\cli.mjs --config .\config.json --apply
```

持续运行并允许切换：

```powershell
node .\src\cli.mjs --config .\config.json --run --apply
```

### 2.4 人工接管

人工接管按以下顺序操作：

1. **停止后台控制：** 先停止或禁用守护，避免手动选择与后台控制相互覆盖。
2. **执行人工操作：** 在 Mihomo 或 Clash Verge 中调整选择或退出客户端。
3. **恢复前检查：** 确认没有现存守护实例，再按对应平台的后台运行章节恢复。

> [!WARNING]
> **单实例约束：** 已有实例运行时，不要再启动第二个守护实例。

### 2.5 守护恢复

完成人工操作并确认没有现存守护实例后，按对应平台的后台运行步骤恢复。服务状态与业务状态应分别核对，不能只以计划任务或守护进程存在作为恢复成功证据。

## 03 后台部署

### 3.1 Windows

**安装与启动**

**第1步 · 完成首次检查：** 先按[首次运行](#01-首次运行)验证配置、Controller 和真实业务探测。

**第2步 · 安装计划任务：** 在项目目录执行以下命令，注册当前用户登录时启动的任务。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

**第3步 · 确认服务与业务：** 使用下节的 `status` 查看服务层状态，再用 CLI `--status` 查看业务结果与实际程序版本。

**管理与人工接管**

使用 BAT 公开入口管理服务：

| 操作 | 效果 |
|---|---|
| `start` | 立即启动。 |
| `stop` | 停止当前进程，精确清理本项目残留 Node.js 进程和锁文件。 |
| `restart` | 重启。 |
| `disable` | 停止并禁用登录自启，适合持续人工接管。 |
| `enable` | 恢复登录自启，不立即启动。 |
| `status` | 查看服务层状态。 |

```powershell
.\scripts\service-windows.bat start
.\scripts\service-windows.bat stop
.\scripts\service-windows.bat restart
.\scripts\service-windows.bat disable
.\scripts\service-windows.bat enable
.\scripts\service-windows.bat status
```

**任务启用：** `start` 或 `restart` 不会隐式启用已禁用的任务，需要先执行 `enable`。

**任务名称：** 默认管理 `MihomoRouteSentinel`；可通过 `-TaskName` 管理自定义安装名称。

**清理边界：** 内部 PowerShell 调用计划任务 API、精确核验 PID 并清理锁文件。`stop` 仅结束命令行含本项目 `src\cli.mjs` 完整路径的 Node.js 进程，不批量结束其他 Node.js 程序。

**卸载**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1
```



### 3.2 Linux systemd

**安装与验证**

**第1步 · 准备路径与用户：** 安装器依次接收项目绝对路径、配置绝对路径、运行用户。省略时使用当前项目、项目内 `config.json` 和 `sudo` 发起用户。

**第2步 · 安装并启动：** 以下示例将服务安装到 systemd，并启动实例。

```sh
sudo sh ./scripts/install-linux.sh \
  /opt/mihomo-route-sentinel \
  /opt/mihomo-route-sentinel/config.json \
  mihomo
sudo sh ./scripts/service-unix.sh start
sudo sh ./scripts/service-unix.sh status
```

**第3步 · 核对业务状态：** 服务层 `status` 后，再用 CLI `--status` 核对业务结果和实际版本。管理命令见下方[Unix 服务管理与验收边界](#unix-服务管理与验收边界)。

**凭据与访问边界**

**凭据注入：** Controller 需要 secret 时，由管理员在 `/etc/mihomo-route-sentinel.env` 中设置对应环境变量并限制文件权限。安装器不会读取或写入 secret。

> [!WARNING]
> **访问保护：** HTTP Controller 必须只监听受信任接口，并通过防火墙或 secret 保护。



### 3.3 macOS launchd

**安装与验证**

macOS 使用当前用户的 LaunchAgent，不会打开终端窗口。

**第1步 · 完成首次检查：** 先确认配置、Controller 和真实业务探测均可用。

**第2步 · 安装并查看状态：** 在项目目录执行以下命令。

```sh
sh ./scripts/install-macos.sh \
  /Users/me/mihomo-route-sentinel \
  /Users/me/mihomo-route-sentinel/config.json
sh ./scripts/service-unix.sh status
```

**第3步 · 核对业务状态：** 再用 CLI `--status` 核对业务结果与实际程序版本；服务管理和平台验收边界见下节。

**凭据注入：** Controller 需要 secret 时，由 MDM、Keychain 辅助程序或组织批准的凭据机制，将 `controller.secretEnv` 指定的环境变量注入当前 `gui/<uid>` launchd 域。

> [!WARNING]
> **凭据存放：** 不要把 secret 写入 plist、JSON 或命令历史。



### 3.4 平台边界

Linux 和 macOS 共用以下管理命令：

```sh
sh ./scripts/service-unix.sh start
sh ./scripts/service-unix.sh stop
sh ./scripts/service-unix.sh restart
sh ./scripts/service-unix.sh disable
sh ./scripts/service-unix.sh enable
sh ./scripts/service-unix.sh status
```

| 操作或平台 | 行为与权限 |
|---|---|
| `disable` | 停止实例，并禁用自启。 |
| `enable` | 只恢复自启权限，不主动启动。 |
| Linux | 需要有权限管理 systemd；上面的安装示例通过 `sudo` 管理。 |
| macOS | 管理当前用户的 `gui/<uid>` LaunchAgent。 |

> [!WARNING]
> **验收边界：** 本轮在 Windows 完成 shell/plist/unit 文本与命令覆盖检查。当前机器无 systemd 和 launchd，Linux/macOS 的安装、权限与启停仍需在目标系统实机验收。

## 04 配置字段参考

以下字段与 `config.example.json` 一一对应。时间字段未特别说明时单位为秒，延迟字段单位为毫秒。

### 4.1 基础与 Controller

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `configVersion` | `7` | 配置格式版本。旧版配置只在内存中迁移，原文件不会被改写。 |
| `controller.transport` | `auto` | Controller 连接方式：`auto`、`http` 或 `pipe`；`auto` 在 Windows 优先发现 Clash Verge Named Pipe。 |
| `controller.url` | `http://127.0.0.1:9090` | HTTP Controller 地址；使用 `http` 时生效，也是 `auto` 无法发现管道时的后备地址。 |
| `controller.pipePath` | 空 | 显式 Named Pipe 路径；留空时按 `pipePattern` 自动发现。 |
| `controller.pipePattern` | `^verge-mihomo-(production\|sidecar-release)-` | 自动发现 Named Pipe 的正则表达式。 |
| `controller.secretEnv` | `MIHOMO_CONTROLLER_SECRET` | Controller 密钥所在的环境变量名；配置文件不保存密钥值。 |
| `controller.requestTimeoutMs` | `5000` | Controller API 单次请求超时。 |

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



### 4.2 目标组与候选组

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `groups.target` | 占位符 | Sentinel 实际控制的 Selector，必须替换 `CHANGE_ME_TARGET_SELECTOR`。 |
| `groups.candidates` | 占位符 | 提供可选节点的代理组，必须替换 `CHANGE_ME_CANDIDATE_GROUP`。 |



### 4.3 业务探测与健康门槛

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `probes.urls` | ChatGPT、OpenAI API | 真实业务探测 URL 列表，至少两个 HTTP/HTTPS 地址。 |
| `probes.controlUrls` | Cloudflare 204 | 非 OpenAI 对照 URL，用于区分节点故障与上游服务故障。 |
| `probes.timeoutMs` | `5000` | 单次 URL 探测超时。 |
| `probes.currentRounds` | `2` | 每周期对当前节点执行的探测轮数。 |
| `probes.confirmRounds` | `3` | 硬故障/尖峰二次确认的探测轮数，取值 1–10；至少 `ceil(rounds×2/3)` 轮仍异常才算确认。 |
| `probes.confirmTimeoutMs` | `2000` | 二次确认的单目标超时上限；实际取值不高于 `probes.timeoutMs`。 |
| `probes.currentMinSuccessRate` | `1` | 当前节点健康所需成功率；`1` 表示 100%。 |
| `probes.currentMaxAverageMs` | `800` | 当前节点可接受的平均延迟上限。 |
| `probes.currentMaxSingleMs` | `1500` | 当前节点可接受的单次最大延迟上限。 |



### 4.4 候选发现与准入

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `probes.discoveryTimeoutMs` | `1200` | 前台快速发现的单目标超时；后台发现取本值与 `timeoutMs` 的较大值，保留慢速可达出口。 |
| `probes.scanDeadlineMs` | `3000` | 前台候选扫描硬截止，最大 3000 ms；后台使用独立计算的截止预算。 |
| `probes.preSwitchValidationDeadlineMs` | `3000` | 切前复核基准，配置最大3000ms；普通复核按候选批次、轮数、目标数与单目标超时扩展，紧急扩展覆盖一轮全部目标。 |
| `probes.scanRounds` | `1` | 初筛每个候选的探测轮数。 |
| `probes.scanUrlCount` | `2` | 初筛使用 `urls` 前 N 个地址；默认同时覆盖 ChatGPT 与 OpenAI API，降低单目标偶然值误导排序的概率。 |
| `probes.validationRounds` | `2` | 严格验证轮数；实际至少采两轮，兼容值为1的旧配置也不能降低严格证据要求。 |
| `probes.topCandidates` | `6` | 故障实时复核的前列候选数量；后台严格复测短名单最多由 `maxValidationCandidates` 限定。 |
| `probes.maxValidationCandidates` | `18` | 单次扫描最多严格验证的候选总数，避免初筛瞬时抖动把真正稳定的节点排除在前 6 名之外。 |
| `probes.parallelism` | `8` | 逐节点发现、后台严格复测及前台切前复核的并发节点上限。 |
| `probes.candidateMinSuccessRate` | `1` | 候选准入成功率；默认要求 100%。 |
| `probes.candidateMaxAverageMs` | `600` | 候选准入平均延迟上限。 |
| `probes.candidateMaxSingleMs` | `1200` | 候选准入单次最大延迟上限。 |
| `probes.includeRegex` | 空 | 只允许名称匹配该正则的节点；空表示不限制。 |
| `probes.excludeRegex` | 空 | 排除名称匹配该正则的节点；空表示不排除。 |

探测阶段、完整证据、串行互斥与截止后的处理，见[规则与状态](docs/design.md#04-规则与状态)。紧急扩展窗口见同一页的恢复流程。



### 4.5 切换条件与安全限制

以下字段决定异常确认、候选选择、隔离、回滚和预算。完整判定顺序、优先级和例外见[规则与状态](docs/design.md#04-规则与状态)。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `policy.intervalSeconds` | `30` | 主健康检查周期；上一轮超时则完成后立即进入下一轮。 |
| `policy.partialFailureCycles` | `2` | 部分请求失败连续达到该周期数后触发候选扫描。 |
| `policy.latencyFailureCycles` | `3` | 纯延迟退化连续达到该周期数后评估切换。 |
| `policy.degradationWindowCycles` | `10` | 统计间歇性延迟退化的滚动周期数，健康周期不会再直接抹掉历史尖峰。 |
| `policy.degradationWindowFailures` | `3` | 滚动窗口内达到该退化次数即触发择优扫描。不得大于窗口周期数。 |
| `policy.optimizationIntervalSeconds` | `900` | 当前节点不是“优秀”时执行周期择优的间隔；`0` 表示关闭周期择优。 |
| `policy.hardFailureConfirmSeconds` | `5` | 硬故障或不可接受尖峰进入多轮确认前的等待时间；确认轮次与超时见 `probes.confirmRounds` / `probes.confirmTimeoutMs`。 |
| `policy.minimumDwellSeconds` | `120` | 纯延迟优化的最短驻留时间；故障恢复不受此限制。 |
| `policy.minimumImprovementMs` | `200` | 延迟型切换要求候选至少改善的绝对延迟。 |
| `policy.minimumImprovementRatio` | `0.2` | 延迟型切换要求候选至少改善的比例；默认 20%。绝对值与比例满足其一即可。 |
| `policy.failedNodeQuarantineSeconds` | `900` | `verify` / `network` 类隔离的默认时长；切前质量不达标使用 `qualityQuarantineSeconds`，普通采样不完整不隔离。 |
| `policy.qualityQuarantineSeconds` | `180` | 切前质量复核不达标（未过严格线）的短隔离时间；质量不足不等于网络失败，避免一次复核清空候选池。 |
| `policy.oldNodeCooldownSeconds` | `120` | 成功切换后旧出口的冷却时间，避免它立刻被重新当成优化候选。 |
| `policy.maxSwitchAttempts` | `3` | 单次恢复流程最多执行的实际节点切换次数；切前门禁拒绝不会占用次数，服务会继续检查候选池中的后续节点。 |
| `policy.postSwitchDelaySeconds` | `2` | 切换后开始复核前的等待时间。 |
| `policy.postSwitchRounds` | `2` | 切换后新节点必须通过的验证轮数。 |
| `policy.rollbackOnFailure` | `true` | 新节点验证失败时，仅在原节点重新合格后允许回滚。 |
| `policy.emergencySuccessRate` | `0.5` | 成功率小于或等于该值视为硬故障。 |
| `policy.emergencyMaxAverageMs` | `3000` | 平均延迟超过该值视为硬故障。 |
| `policy.immediateMaxSingleMs` | `2500` | 任一次真实探测超过该值即进入快速复核。 |
| `policy.candidateScanBackoffSeconds` | `120` | 没有合格候选后的再次扫描退避。 |
| `policy.switchBudgetCount` | `3` | 优化池与恢复池各自的滚动切换上限；两池独立。另有受条件约束的安全恢复额度。 |
| `policy.switchBudgetWindowSeconds` | `600` | 优化、恢复与安全恢复三本账共用的滚动窗口长度；`rescue` 固定为同窗口一次，不新增配置项。 |
| `policy.upstreamFailureMinCandidates` | `3` | 至少多少个候选呈现同类业务失败时，可结合对照 URL 判定上游故障并抑制切换。 |
| `policy.candidateSnapshotRefreshSeconds` | `60` | 持续运行时后台刷新候选快照的间隔。 |
| `policy.candidateSnapshotMaxAgeSeconds` | `120` | 可复用快照的最大年龄，不得小于刷新间隔。过期或选择不匹配即失效。 |
| `policy.emergencySwitchDeadlineMs` | `1000` | 紧急快速复核、决策、守卫和 Controller 切换的 SLO，最大 1000 ms；不是端到端恢复承诺。 |

预算消费与回滚规则见[三类切换预算](#三类切换预算)；快照与一秒目标见[紧急恢复的时间边界](#紧急恢复的时间边界)；质量阈值见[延迟等级与遥测](#延迟等级与遥测)。



### 4.6 客户端与配置守卫

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

**适用范围：** 进程守卫仅在 Windows 执行，开源默认关闭，避免主动退出客户端时被意外拉起。它不会杀死或强制重启已运行的正常客户端。

**失败处理：** 启动文件缺失、进程路径与配置不符、启动失败，或 Controller 未在超时内恢复时，保持 `blocked`，停止探测与切换，并按退避时间重试。

**探测中退出：** Clash Verge 在健康探测期间退出可能中断 Controller 请求。持续运行模式通过同一守卫队列立即恢复客户端，记录 `watchdog-cycle-interrupted-by-client-restart`，下一周期继续检查，避免将已恢复的退出误报为持续故障。



### 4.7 遥测与日志

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `logging.maxBytes` | `5242880` | 单个 NDJSON 日志文件达到该字节数后轮转。 |
| `logging.retainedFiles` | `14` | 保留的轮转日志份数。 |
| `telemetry.enabled` | `true` | 是否额外检测经本地代理访问 HTTPS 与 WebSocket 的真实链路。 |
| `telemetry.proxyUrl` | `http://127.0.0.1:7897` | 遥测使用的本地 HTTP 代理地址，应与客户端监听端口一致。 |
| `telemetry.httpsUrl` | `https://chatgpt.com/` | HTTPS/TLS/TTFB 遥测目标。 |
| `telemetry.websocketUrl` | Codex Responses WebSocket | WebSocket 握手遥测目标。 |
| `telemetry.timeoutMs` | `5000` | 每项遥测超时。 |
| `telemetry.businessFailureMarksDegraded` | `false` | 是否把「网络可达但业务结果非 accepted/upgraded」（如 401/403、WS 未升级）视为业务降级；默认关闭，仅记录不参与健康判定。 |



### 4.8 状态与运行文件

所有相对路径都以 `config.json` 所在目录为基准；从其他目录运行时，应优先用 `--status` 输出的绝对日志路径。

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `files.state` | `./var/state.json` | 健康周期、节点准入、隔离和切换预算状态文件。 |
| `files.log` | `./var/watchdog.ndjson` | 结构化运行日志；在配置目录中可用 `Get-Content .\\var\\watchdog.ndjson -Wait` 实时查看。 |
| `files.lock` | `./var/watchdog.lock` | 原子租约单实例锁，绑定 Controller 指纹，防止同一 Controller 多实例同时切换。 |
| `files.guardrailState` | `./var/guardrails.json` | DNS 已修改但尚未确认重载的持久债务；只有运行态复核成功才会清除。 |

配置在启动时严格校验：轮数、并发数、周期和预算必须是整数，成功率必须在 0–1 内，正则必须可编译，业务探测 URL 只允许 HTTP/HTTPS，遥测 URL 必须匹配各自协议。无效配置会在连接 Controller 或切换节点前终止。

## 05 状态判读与运行维护

### 5.1 状态总览

- **`var/state.json`：** 当前节点、连续失败、后台扫描状态、最近扫描/切换、隔离节点和滚动切换预算。Dry Run 不写此文件。
- **`var/watchdog.ndjson`：** 健康结果和 TLS/TTFB/WebSocket 指标，不记录 Controller secret 或节点服务器地址。达到 `logging.maxBytes` 后轮转，保留 `logging.retainedFiles` 份。
- **`var/watchdog.lock`：** 防止重复实例。
- **`var/guardrails.json`：** DNS 修复后的待重载/待复核债务，问题确认解决后自动清除。

**服务状态与业务状态**

| 查看入口 | 用途 |
|---|---|
| Windows `service-windows.bat status` | 查看 Windows 服务层状态。 |
| Unix `service-unix.sh status` | 查看 systemd 或 launchd 服务层状态。 |
| CLI `--status` | 阅读业务状态及实际后台版本。 |
| CLI `--status-json` | 供机器处理的业务状态。 |

**实际版本：** 状态显示后台进程写入的程序版本、PID 和启动时间，可识别任务虽为 Running 却仍加载旧代码的情况。健康结果、准入等级、三类预算和最近决策分别展示。

**扫描进度：** 状态显示实际预算、耗时、截止是否触发及严格/临时候选。后台完整扫描与前台三秒扫描分别呈现；候选快照刷新完成后立即清除 `running`。

**复核时限：** 常规切前复核按候选批次扩展，单批默认上限 20000 ms（2 轮×2 目标×5 s）；前台冷扫描上限 3000 ms。紧急切换日志另记录 `decisionDurationMs` 与 `deadlineMet`；一秒目标不含故障确认、发现和冷扫描，边界见[快照辅助恢复](docs/design.md#32-快照辅助恢复)。





### 5.2 健康、准入与预算

**健康与准入：** 健康描述当前业务质量，准入描述当前出口取得的验证证据。`healthy` 不代表已经达到 `strict`；未通过严格候选线本身不触发故障切换。完整健康触发与准入证据见[规则与状态](docs/design.md#04-规则与状态)。

**预算：** 优化、恢复与有界安全恢复使用独立额度。查看 `--status` 时，应区分“预算不可用”和“当前链路故障”；预算耗尽不会改变健康结论。完整额度、消费时点、回滚豁免与旧状态迁移见[预算与回滚](docs/design.md#45-预算与回滚)。

**恢复时限：** 故障确认、候选发现、快速复核、扩展复核和实际切换分别计时。“扫描 3 秒”或“一秒 SLO”都不是端到端恢复承诺。具体路径见[恢复流程](docs/design.md#02-恢复流程)和[扫描与时限](docs/design.md#44-扫描与时限)。

**证据判读：** 状态中的最近动作、候选快照、扫描截止、实际耗时和 `deadlineMet` 用于解释保持或切换。历史成功、旧快照或单轮样本不能补成当前严格证据。



### 5.3 未切换排查

| 现象 | 检查入口 |
|---|---|
| 当前健康为 `healthy`，准入仍为 `pending` 或 `usable` | 严格证据不足；查看 `5.2 健康、准入与预算`，健康不等于已严格合格 |
| 配置守卫显示 `blocked` 或正在修复 | 查看 `5.4 守卫处置`，确认客户端、运行模式与 DNS 状态 |
| 切换预算不可用 | 查看 `5.2` 的预算部分，核对优化、恢复与安全恢复账本 |
| 没有有效候选 | 查看状态中的扫描结果、截止、失败原因和候选隔离 |
| 有合格候选但选择未改变 | 检查最短驻留、改善门槛、上游故障判断与选择身份 |
| 日志显示 `deadlineMet=false` | 一秒目标已经超出；查看实际耗时与后续恢复结果 |



### 5.4 守卫处置

每个监控周期都会先执行配置守卫，再进行链路探测和节点切换。完整触发条件与状态模型见[恢复流程](docs/design.md#02-恢复流程)。

1. **检查客户端：** 可选 Windows 进程守卫检查同一用户会话中的 `clash-verge.exe`。未运行则按可信路径隐藏启动，等待 Controller 恢复；失败后退避。
2. **检查运行模式：** 每个主周期读取 Mihomo `/configs`，独立守卫还按 `runtimeModeCheckIntervalSeconds` 检查。发现 `direct` 时立即改回配置的 `rule` 或 `global` 并复核。
3. **限定模式修复范围：** 只调用 Mihomo 官方 API，不读取或重写可能含节点与凭据的 `config.yaml`。Clash Verge 重启后再次纠正。
4. **检查 DNS 覆写：** Windows 仅定位需要关闭的布尔字段，停止同一会话的 Clash Verge 后原位修改，不生成包含其他配置的临时副本。
5. **复核重载：** 隐藏重启 Clash Verge，同时确认持久化开关、生成配置刷新、Controller 恢复及运行模式；本周期暂停节点切换。
6. **保留修复债务：** DNS 重载债务存入独立状态文件，跨周期和重启保留。任何修复或复核失败都保持 `blocked`，停止探测和切换。

默认单次命令是 Dry Run：只报告 `would-repair`，不会修改 Mihomo 或 Clash Verge。计划任务使用 `--apply`，会自动修复。`--status` 分别显示“客户端进程守卫”和“配置守卫”的最近状态、问题与修复结果。

Windows 可自动完成上述 DNS 修复闭环。Linux 和 macOS 只有显式配置 `guardrails.clashVergeAppDir` 时才检测，且当前不修改第三方配置；发现 DNS 覆写时保持 `blocked` 并给出问题代码。



### 5.5 日志与升级

**日志定位**

使用 `--status` 查看状态中的绝对日志路径。结构化日志记录健康结果、候选扫描、选择、守卫与真实链路遥测；Controller secret、订阅和节点服务器地址不会写入日志。

**升级检查**

升级前核对 `package.json` 版本、配置格式版本和当前实际运行版本。旧配置只在内存中迁移，原文件不会被改写；未来不兼容版本会在启动时拒绝。正式升级仍以[迭代记录](docs/iterations.md)中的已验证范围为准。

**开源许可**

本项目采用 [MIT License](./LICENSE)。

**产品审查 Agent**

- **`agents/product-manager.md`：** 可复用的产品经理 Agent 角色、检查维度和输出契约。
- **`docs/product-review-2026-10-23.md`：** 历史独立审查结论；参数和建议只代表当时版本。当前策略见本手册，当前遗留与计划见[迭代记录](docs/iterations.md)。
