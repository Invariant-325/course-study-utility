$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath 'node_modules/electron-builder/cli.js')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  $runtime = Join-Path $PSScriptRoot 'node_modules/electron/dist'
  if (-not (Test-Path -LiteralPath (Join-Path $runtime 'electron.exe'))) {
    throw 'Electron runtime is missing. Run npm ci with downloads enabled.'
  }
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  & node node_modules/electron-builder/cli.js --win nsis --x64 --publish never "--config.electronDist=$runtime"
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
  & node scripts/verify-package.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }
} finally {
  Pop-Location
}
