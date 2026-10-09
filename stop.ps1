$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'work/server.pid'
if (Test-Path $pidFile) {
    $taskServerId = [int]([IO.File]::ReadAllText($pidFile).Trim())
    $taskServer = Get-Process -Id $taskServerId -ErrorAction SilentlyContinue
    $expectedExe = Join-Path $PSScriptRoot 'work/runtime/node_modules/deno/deno.exe'
    if ($taskServer -and $taskServer.Path -eq $expectedExe) { Stop-Process -Id $taskServerId }
}
$npuPidFile = Join-Path $PSScriptRoot 'work/npu-server.pid'
if (Test-Path $npuPidFile) {
    $npuServerId = [int]([IO.File]::ReadAllText($npuPidFile).Trim())
    $npuServer = Get-Process -Id $npuServerId -ErrorAction SilentlyContinue
    $expectedNpuExe = Join-Path $PSScriptRoot 'work/python-arm64/python.exe'
    if ($npuServer -and $npuServer.Path -eq $expectedNpuExe) { Stop-Process -Id $npuServerId }
}
