[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$TaskName = 'MihomoRouteSentinel',
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$ConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Join-Path $projectRoot 'config.json'
} else {
    $ConfigPath
}
$cliPath = Join-Path $projectRoot 'src\cli.mjs'
$launcherPath = Join-Path $PSScriptRoot 'run-hidden.vbs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$configPath = [IO.Path]::GetFullPath($ConfigPath)

if (-not (Test-Path -LiteralPath $cliPath)) {
    throw "找不到 CLI: $cliPath"
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "找不到配置文件: $configPath"
}
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "找不到隐藏启动器: $launcherPath"
}

$null = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$arguments = "//B //NoLogo `"$launcherPath`" `"$nodePath`" `"$cliPath`" `"$configPath`""
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $arguments -WorkingDirectory $projectRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $existing = Get-ScheduledTask -TaskName $TaskName
    } while ($existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    if ($existing.State -eq 'Running') {
        throw "停止旧计划任务 '$TaskName' 超时。"
    }
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Monitor AI service route quality through Mihomo and fail over to a validated route.' `
    -User $identity `
    -RunLevel Limited `
    -Force | Out-Null

# 注册替换后给 Task Scheduler 留出提交新 Action 的时间，避免立即启动旧定义。
Start-Sleep -Milliseconds 500

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
