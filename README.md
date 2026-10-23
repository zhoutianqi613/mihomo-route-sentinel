# Mihomo Route Sentinel

面向 Mihomo / Clash Verge Rev 的 AI 业务链路质量守卫与自动故障转移工具。它使用真实业务目标评估整条代理路由，在当前路径连续退化后扫描候选节点、复测、切换并验证；候选验证失败时会隔离该节点并继续尝试，不会直接回到未经复测的故障路径。

## 特性

- Node.js 20+，零第三方依赖。
- Windows 自动发现 Clash Verge 的 Mihomo Named Pipe。
- Linux、macOS、路由器等环境可使用标准 HTTP Controller。
- secret 仅从环境变量读取，不写入配置或日志。
- 区分瞬时异常、部分失败、延迟退化和硬故障。
- 全节点快速扫描后，只对前 N 名多轮复测。
- 最短驻留、改善幅度、节点隔离、扫描退避和切换预算避免节点抖动。
- 使用公共对照 URL 识别上游整体故障，避免无意义换节点。
- 记录 HTTPS 的 TLS/TTFB 与 WebSocket 链路指标，结构化日志按大小轮转。
- 配置版本化：兼容无版本的 v1，拒绝未来的不兼容版本。
- Windows 使用隐藏的 Windows Script Host 启动计划任务，后台运行时不显示 Node.js 终端窗口。
- 默认单次 Dry Run；必须显式使用 `--apply` 才会修改节点选择。

## 快速开始

```powershell
Copy-Item .\config.example.json .\config.json
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

## 配置重点

- `configVersion`：当前为 `2`。无此字段的旧配置按 v1 在内存中迁移，原文件不会被改写。
- `groups.target`：需要被切换的 Selector。必须把示例的 `CHANGE_ME_TARGET_SELECTOR` 改为实际组名。
- `groups.candidates`：包含实际节点的候选组。必须把 `CHANGE_ME_CANDIDATE_GROUP` 改为实际组名。
- `probes.urls`：真实业务目标，应至少配置两个。
- `probes.controlUrls`：不依赖 OpenAI 的公共对照目标，用于区分节点故障和上游故障。
- `currentRounds`：每轮对当前节点的探测次数。
- `partialFailureCycles`：部分请求失败多少个周期后切换。
- `latencyFailureCycles`：纯延迟退化多少个周期后评估切换。
- `includeRegex` / `excludeRegex`：限制允许参与切换的节点名称。
- `minimumDwellSeconds`：只约束纯延迟优化的最短驻留时间；不阻止故障恢复。
- `minimumImprovementMs` / `minimumImprovementRatio`：延迟型切换所需的最小收益。
- `failedNodeQuarantineSeconds`：故障节点隔离时间。
- `candidateScanBackoffSeconds`：没有合格候选时的再扫描退避，默认 120 秒。
- `switchBudgetCount` / `switchBudgetWindowSeconds`：滚动时间窗内的最大切换数，默认 10 分钟内 3 次。
- `logging.maxBytes` / `logging.retainedFiles`：单个日志的轮转阈值和保留份数。
- `telemetry.*`：通过本地代理检查 HTTPS TLS/TTFB 和 WebSocket；对不同客户端需要调整 `proxyUrl`。

配置在启动时严格校验：轮数、并发数、周期和预算必须是整数，成功率必须在 0–1 内，正则必须可编译，业务探测 URL 只允许 HTTP/HTTPS，遥测 URL 必须匹配各自协议。无效配置会在连接 Controller 或切换节点前终止。

## 自动切换策略

正常模式按 30 秒固定起始节拍检查，每轮对 ChatGPT 和 OpenAI API 各探测两次。如果一轮扫描本身超过 30 秒，下一轮会在完成后立即开始，不再额外等待：

| 状态 | 判定 | 动作 |
|---|---|---|
| 健康 | 4/4 成功、平均延迟不超过 800 ms、单次不超过 1500 ms | 保持当前节点 |
| 瞬时异常 | 尚未达到对应的连续周期阈值 | 记录，不切换 |
| 部分失败 | 成功率高于 50% 但低于 100%，连续 2 个周期 | 立即扫描和切换，不受最短驻留限制 |
| 延迟退化 | 100% 成功，但平均或单次延迟超标，连续 3 个周期 | 最短驻留结束后，仅切换到至少改善 200 ms 或 20% 的候选 |
| 硬故障 | 成功率不超过 50% 或平均延迟超过 3000 ms | 5 秒后确认；仍失败则立即切换，不受最短驻留限制 |

候选必须 100% 成功、平均延迟不超过 600 ms、单次不超过 1200 ms，并连续两轮验证合格。切换后再次验证两轮；失败候选隔离 15 分钟并继续尝试下一个，最多尝试 3 个。只有原节点重新探测合格时才允许回滚。找不到合格候选后退避 120 秒；10 分钟最多切换 3 次。业务目标整体失败但对照 URL 正常时，按上游故障处理并抑制切换风暴。

延迟质量等级用于日志解释和产品判断，不单独替代成功率与连续周期：

| 等级 | 延迟范围 |
|---|---|
| 优秀 | 平均不超过 500 ms，最大不超过 1000 ms |
| 可接受 | 平均不超过 800 ms，最大不超过 1500 ms |
| 退化 | 平均 800–1200 ms，或最大 1500–2500 ms |
| 不可接受 | 平均超过 1200 ms，或最大超过 2500 ms |
| 硬故障 | 成功率不超过 50%，或平均超过 3000 ms |

平均值可能掩盖尖峰，因此决策同时使用成功率、平值、最大值、抖动和连续周期。HTTPS 遥测分解 TCP/TLS/TTFB/总时长，WebSocket 遥测检查握手。遥测用于运维观测，当前不替代候选节点的多轮准入门槛。

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

- `var/state.json`：当前节点、连续失败、最近扫描/切换、隔离节点和滚动切换预算。Dry Run 不写此文件。
- `var/watchdog.ndjson`：结构化运行日志，包含健康结果和 TLS/TTFB/WebSocket 指标，不记录 controller secret 或节点服务器地址。达到 `logging.maxBytes` 后轮转，保留 `logging.retainedFiles` 份。
- `var/watchdog.lock`：防止重复实例。

Windows 的 `service-windows.bat status` 以及 Unix 的 `service-unix.sh status` 用于查看服务层状态；业务状态使用 CLI `--status` 或便于机器处理的 `--status-json`。

## 开源许可

本项目采用 [MIT License](./LICENSE)。

## 产品审查 Agent

- `agents/product-manager.md`：可复用的产品经理 Agent 角色、检查维度和输出契约。
- `docs/product-review-2026-10-23.md`：本轮独立审查结论、已修复项和后续路线图。
