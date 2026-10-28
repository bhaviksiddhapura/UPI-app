# One-shot Windows setup: download (if needed), install, configure and start YOUPI PG.
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/bhaviksiddhapura/UPI-app.git'
$branch = 'claude/gifted-ritchie-m9zzjp'
$dir = Join-Path $HOME 'UPI-app'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Installing with winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (Test-Path (Join-Path $dir 'package.json')) {
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

npm install
if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'node_modules\@youpi\common')) {
  Write-Host "`nnpm install did not finish (workspace packages are not linked). Scroll up for the first npm error and send it over." -ForegroundColor Red
  return
}
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

Start-Job { Start-Sleep 8; Start-Process 'http://localhost:5000'; Start-Process 'http://localhost:6001' } | Out-Null
npm run dev
