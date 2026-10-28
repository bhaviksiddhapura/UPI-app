# One-shot Windows setup for YOUPI PG + the one-page Rupee Store.
# Installs, asks for your UPI ID, starts the gateway, connects the store and opens it.
# 'Continue': Windows PowerShell 5.1 treats Node's stderr warnings as errors under 'Stop'.
$ErrorActionPreference = 'Continue'
$repo = 'https://github.com/bhaviksiddhapura/UPI-app.git'
$branch = 'claude/gifted-ritchie-m9zzjp'
$dir = Join-Path $HOME 'UPI-app'

function Test-Up($url) {
  try { Invoke-RestMethod $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Installing with winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# 1. Get or update the code
if (Test-Path (Join-Path $dir '.git')) {
  Set-Location $dir
  git pull origin $branch
} elseif (Test-Path (Join-Path $dir 'package.json')) {
  Set-Location $dir
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone -b $branch $repo $dir
  Set-Location $dir
} else {
  Write-Host 'Git not found, downloading the project as a zip...'
  $zip = Join-Path $env:TEMP 'upi-app.zip'
  $tmp = Join-Path $env:TEMP 'upi-app-extract'
  Invoke-WebRequest "https://github.com/bhaviksiddhapura/UPI-app/archive/refs/heads/$branch.zip" -OutFile $zip
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $dir
  Set-Location $dir
}

# 2. Install
npm install
if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'node_modules\@youpi\common')) {
  Write-Host "`nnpm install did not finish (workspace packages are not linked). Scroll up for the first npm error and send it over." -ForegroundColor Red
  return
}
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

# 3. Your receiving UPI ID
$credFile = 'data\.secrets\rupee_store.json'
$upi = $null
if (-not (Test-Path $credFile)) {
  $upi = Read-Host 'Your UPI ID that should receive the money (e.g. yourname@okhdfcbank)'
  $payee = Read-Host 'Name shown to payers (your name or shop name)'
  # Brings .env up to the hardened settings before the gateway starts (no gateway needed for this part).
  node scripts/configure-store.js --upi $upi --name $payee | Out-Null
}

# 4. Start the gateway in its own window
if (Test-Up 'http://localhost:6100/health') {
  Write-Host 'A gateway is already running. Close that window (Ctrl+C) so it restarts with the new settings, then press Enter.' -ForegroundColor Yellow
  Read-Host | Out-Null
}
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; npm run dev"
Write-Host 'Starting the gateway...'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep 1
  if ((Test-Up 'http://localhost:6100/health') -and (Test-Up 'http://localhost:4000/health')) { $ok = $true; break }
}
if (-not $ok) { Write-Host 'The gateway did not come up in 60 seconds. Check the other window for errors.' -ForegroundColor Red; return }

# 5. Connect the store to the gateway (UPI ID, webhook, fresh merchant key + webhook secret)
if ($upi) {
  node scripts/configure-store.js --upi $upi --name $payee
  if ($LASTEXITCODE -ne 0) { Write-Host 'Connecting the store failed, see the message above.' -ForegroundColor Red; return }
}

Start-Process 'http://localhost:4000'
Start-Process 'http://localhost:6001'
Write-Host ''
Write-Host 'Store:        http://localhost:4000' -ForegroundColor Green
Write-Host 'Admin panel:  http://localhost:6001' -ForegroundColor Green
Write-Host ''
Write-Host 'Before a live payment works you still need (see docs\RUPEE_STORE.md):'
Write-Host '  1. Admin panel > Developer & Infrastructure Hub > Gmail & WhatsApp Protocols: link WhatsApp (customer OTP).'
Write-Host '  2. Phone observer: run  npm run observer:tunnel  in a new window and pair the app on your phone.'
