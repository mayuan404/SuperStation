# 启动、存活检查、日志与截图（VM / 公司电脑都能用）
param(
  [string]$Exe = "$PSScriptRoot\..\..\out\win-x64\SuperWorkStation.exe",
  [int]$WaitSeconds = 10,
  [switch]$NoScreenshot
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $Exe)) {
  Write-Error "找不到 exe: $Exe（先 dotnet publish 或解压发布包）"
  exit 2
}

Get-Process SuperWorkStation -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Write-Output "==> start $Exe"
$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $WaitSeconds

$alive = -not $proc.HasExited
Write-Output "alive=$alive pid=$($proc.Id)"
if (-not $alive) { Write-Output "exitcode=$($proc.ExitCode)" }

$log = Join-Path $env:LOCALAPPDATA 'SuperWorkStation\logs\SuperWorkStation.log'
if (Test-Path $log) {
  Write-Output "==> log tail ($log)"
  Get-Content $log -Tail 40
} else {
  Write-Output "no log file yet: $log"
}

if (-not $NoScreenshot) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $shot = Join-Path $env:TEMP 'sws-smoke.png'
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "screenshot=$shot"
}

Write-Output "==> webview2 runtimes"
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue |
  Select-Object pv, name
