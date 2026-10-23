[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'disable', 'enable', 'status')]
    [string]$Action,

    [string]$TaskName = 'MihomoRouteSentinel'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$cliPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'src\cli.mjs'))
$configPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'config.json'))
$lockPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'var\watchdog.lock'))

function Get-WatchdogTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        throw "计划任务 '$TaskName' 不存在；请先运行 scripts\install-windows.ps1。"
    }
    return $task
}

function Wait-TaskState {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,

        [int]$TimeoutSeconds = 10
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $task = Get-WatchdogTask
        if (& $Condition $task) {
            return $task
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "等待计划任务 '$TaskName' 状态变化超时，当前状态为 '$($task.State)'。"
}

function Get-WatchdogProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($cliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Stop-WatchdogProcesses {
    $processes = @(Get-WatchdogProcesses)
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining = @(Get-WatchdogProcesses)
        if ($remaining.Count -eq 0) {
            if (Test-Path -LiteralPath $lockPath) {
                Remove-Item -LiteralPath $lockPath -Force
            }
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    $processIds = ($remaining | ForEach-Object ProcessId) -join ', '
    throw "无法停止 Watchdog 进程，残留 PID: $processIds"
}

function Stop-WatchdogTask {
    $task = Get-WatchdogTask
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        $task = Wait-TaskState -Condition { param($item) $item.State -ne 'Running' }
    }
    Stop-WatchdogProcesses
    return $task
}

function Start-WatchdogTask {
    $task = Get-WatchdogTask
    if ($task.State -eq 'Disabled') {
        throw "计划任务 '$TaskName' 已禁用；请先执行 enable。"
    }
    if ($task.State -ne 'Running') {
        Start-ScheduledTask -TaskName $TaskName
        $task = Wait-TaskState -Condition { param($item) $item.State -eq 'Running' }
    }
    return $task
}

function Show-WatchdogStatus {
    $task = Get-WatchdogTask
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $processIds = (@(Get-WatchdogProcesses) | ForEach-Object ProcessId) -join ', '
    $actionExecutable = [IO.Path]::GetFileName([string]$task.Actions[0].Execute)
    $backgroundMode = if ($actionExecutable -ieq 'wscript.exe') {
        'HiddenHost'
    } else {
        [string]$task.Principal.LogonType
    }
    [pscustomobject]@{
        TaskName       = $task.TaskName
        State          = $task.State
        StartupEnabled = $task.State -ne 'Disabled'
        BackgroundMode = $backgroundMode
        ProcessIds     = $processIds
        LastRunTime    = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult
    }
}

function Get-WatchdogNodePath {
    param(
        [Parameter(Mandatory = $true)]
        $Task
    )

    $arguments = [string]$Task.Actions[0].Arguments
    $quotedArguments = [regex]::Matches($arguments, '"([^"]+)"')
    foreach ($match in $quotedArguments) {
        $candidate = [string]$match.Groups[1].Value
        if ([IO.Path]::GetFileName($candidate) -ieq 'node.exe' -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return (Get-Command node.exe -ErrorAction Stop).Source
}

function Get-WatchdogConfigPath {
    param(
        [Parameter(Mandatory = $true)]
        $Task
    )

    $arguments = [string]$Task.Actions[0].Arguments
    $quotedArguments = [regex]::Matches($arguments, '"([^"]+)"')
    foreach ($match in $quotedArguments) {
        $candidate = [string]$match.Groups[1].Value
        if ([IO.Path]::GetExtension($candidate) -ieq '.json' -and (Test-Path -LiteralPath $candidate)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return $configPath
}

switch ($Action.ToLowerInvariant()) {
    'start' {
        $null = Start-WatchdogTask
    }
    'stop' {
        $null = Stop-WatchdogTask
    }
    'restart' {
        $task = Get-WatchdogTask
        if ($task.State -eq 'Disabled') {
            throw "计划任务 '$TaskName' 已禁用；请先执行 enable。"
        }
        $null = Stop-WatchdogTask
        $null = Start-WatchdogTask
    }
    'disable' {
        $null = Stop-WatchdogTask
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        $null = Wait-TaskState -Condition { param($item) $item.State -eq 'Disabled' }
    }
    'enable' {
        $task = Get-WatchdogTask
        if ($task.State -eq 'Disabled') {
            Enable-ScheduledTask -TaskName $TaskName | Out-Null
            $null = Wait-TaskState -Condition { param($item) $item.State -ne 'Disabled' }
        }
    }
    'status' {
        $task = Get-WatchdogTask
        $serviceStatus = Show-WatchdogStatus
        Write-Host (($serviceStatus | Format-List | Out-String).TrimEnd())
        Write-Host ''
        $nodePath = Get-WatchdogNodePath -Task $task
        $activeConfigPath = Get-WatchdogConfigPath -Task $task
        & $nodePath $cliPath --config $activeConfigPath --status
        if ($LASTEXITCODE -ne 0) {
            throw "Watchdog 状态命令失败，退出码：$LASTEXITCODE"
        }
        return
    }
}

Show-WatchdogStatus
