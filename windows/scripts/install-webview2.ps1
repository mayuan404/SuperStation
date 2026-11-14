# 在 VM / 新电脑上安装 WebView2 运行时（x64）

SuperWorkStation 是 x64 应用，需要 **x64 版** WebView2 运行时。Win11 通常自带；ARM64 设备上
自带的 Edge 是 ARM64，x64 应用还需要额外装一份 x64 运行时。

```powershell
$key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$pv = (Get-ItemProperty $key -ErrorAction SilentlyContinue).pv
if ($pv) {
  Write-Output "WebView2 runtime already installed: $pv"
  exit 0
}

$installer = Join-Path $env:TEMP 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
Write-Output "downloading x64 WebView2 runtime..."
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -Wait
$pv = (Get-ItemProperty $key -ErrorAction SilentlyContinue).pv
Write-Output "installed: $pv"
```

装完重新运行 `SuperWorkStation.exe` 即可。
