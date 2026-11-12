$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host '=== Sapo Direct Print Agent - Setup ===' -ForegroundColor Green
Write-Host 'May in Windows da duoc cai dat:'
try {
  Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline | Format-Table -AutoSize
} catch {
  Write-Host 'Khong doc duoc danh sach may in. Hay kiem tra trong Windows Settings.' -ForegroundColor Yellow
}

$workerUrl = Read-Host 'Nhap URL website Cloudflare (https://...)'
$agentToken = Read-Host 'Nhap PRINT_AGENT_TOKEN da tao tren Cloudflare'
$printerName = Read-Host 'Ten may in Windows (bo trong de dung may in mac dinh)'
$shopName = Read-Host 'Ten cua hang in tren dau bill (co the bo trong)'
if ([string]::IsNullOrWhiteSpace($workerUrl) -or [string]::IsNullOrWhiteSpace($agentToken)) {
  throw 'Can nhap workerUrl va PRINT_AGENT_TOKEN.'
}
if ($workerUrl -notmatch '^https://') { throw 'URL website phai bat dau bang https://' }
$config = [ordered]@{
  workerUrl = $workerUrl.TrimEnd('/')
  agentToken = $agentToken.Trim()
  printerName = $printerName
  shopName = $shopName
  heartbeatSeconds = 25
}
$configPath = Join-Path $here 'config.json'
$json = $config | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
Write-Host "Da tao $configPath" -ForegroundColor Green
Write-Host 'Tiep theo chay: npm install; npm start' -ForegroundColor Cyan
