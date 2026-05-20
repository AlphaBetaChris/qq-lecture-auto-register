# 关闭讲座自动报名助手所有相关进程

Write-Host "[1/4] 正在关闭 NapCat 及其启动的 QQ 进程（保留日常QQ）..."
Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue | Stop-Process -Force

Get-WmiObject Win32_Process | Where-Object {
    $_.Name -eq 'QQ.exe' -and $_.CommandLine -like '*--enable-logging*'
} | ForEach-Object {
    Write-Host "  关闭 QQ.exe PID=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "[2/4] 正在关闭后台 Node 服务..."
Get-WmiObject Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -like '*lecture-auto-register*'
} | ForEach-Object {
    Write-Host "  关闭 node.exe PID=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "[3/4] 正在关闭相关终端窗口..."

# 先找到目标 cmd.exe 的 PID
$targetCmdPids = Get-WmiObject Win32_Process | Where-Object {
    $_.Name -eq 'cmd.exe' -and (
        $_.CommandLine -like '*run-auto-register-app*' -or
        $_.CommandLine -like '*launcher-user*'
    )
} | Select-Object -ExpandProperty ProcessId

Write-Host "  目标 cmd.exe PIDs: $($targetCmdPids -join ', ')"

# 找 Windows Terminal 进程，检查其子进程是否包含目标 cmd
$wtProcesses = Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'WindowsTerminal.exe' }

foreach ($wt in $wtProcesses) {
    # 找该 Windows Terminal 下的所有子孙进程
    $children = Get-WmiObject Win32_Process | Where-Object { $_.ParentProcessId -eq $wt.ProcessId }
    $childPids = $children | Select-Object -ExpandProperty ProcessId

    $isTarget = $childPids | Where-Object { $targetCmdPids -contains $_ }
    if ($isTarget) {
        Write-Host "  关闭 WindowsTerminal.exe PID=$($wt.ProcessId)（包含目标终端）"
        Stop-Process -Id $wt.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# 兜底：直接杀目标 cmd.exe
foreach ($pid in $targetCmdPids) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}

Write-Host "[4/4] 正在清理端口 39211 / 39212..."
foreach ($port in @(39211, 39212)) {
    $lines = netstat -ano | Select-String ":$port\s"
    foreach ($line in $lines) {
        $parts = ($line.ToString().Trim() -split '\s+')
        $pid = $parts[-1]
        if ($pid -match '^\d+$' -and [int]$pid -ne 0) {
            Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
Write-Host "========================================"
Write-Host "已成功停止所有相关进程！"
Write-Host "（Web控制台的网页请在浏览器中手动关闭）"
Write-Host "========================================"
Start-Sleep -Seconds 2
