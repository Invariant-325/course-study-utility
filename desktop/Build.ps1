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

  # 定位 rcedit：把"写产品资源"从临时环境变量变成可重复的构建步骤。
  # after-pack.cjs 只在 CHAOXING_RCEDIT 存在时才改 EXE 的图标/产品名/版本；
  # 不设它，产物会保留 Electron 默认的 "Electron / <electron 版本>"。
  $rcedit = $env:CHAOXING_RCEDIT
  if (-not $rcedit -or -not (Test-Path -LiteralPath $rcedit)) {
    $probe = @(
      (Join-Path $PSScriptRoot 'node_modules/rcedit/bin/rcedit-x64.exe'),
      'C:\Users\Invariant\Documents\Codex\2026-11-10\zhe-2\work\chaoxing-rebuild\tools\rcedit-x64.exe'
    )
    $rcedit = $probe | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if ($rcedit) {
    $env:CHAOXING_RCEDIT = $rcedit
    Write-Host "rcedit: $rcedit"
  } else {
    Write-Warning 'rcedit missing: EXE keeps Electron default product name/version.'
  }

  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  & node node_modules/electron-builder/cli.js --win nsis --x64 --publish never "--config.electronDist=$runtime"
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }

  & node scripts/verify-package.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Package verification failed' }

  # 构建后校验 EXE 产品资源与 package.json 一致
  # PowerShell 5.1 的 ConvertFrom-Json 对深层 package.json 会抛 ArgumentException，改用 node 读版本
  $pkgVersion = (& node -p "require('./package.json').version").Trim()
  $exe = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/win-unpacked/CourseStudyUtility.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "Built executable not found: $exe" }
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  Write-Host ("EXE resources: ProductName='{0}' ProductVersion='{1}' FileVersion='{2}'" -f $vi.ProductName, $vi.ProductVersion, $vi.FileVersion)
  if ($rcedit) {
    $expectedName = [string](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build/product-name.txt') -Raw -ErrorAction SilentlyContinue)
    if (-not $expectedName) { $expectedName = [char]0x8BFE + [char]0x7A0B + [char]0x4F34 + [char]0x5B66 + [char]0x5DE5 + [char]0x5177 }
    if ($vi.ProductVersion -ne $pkgVersion) { throw "ProductVersion mismatch: '$($vi.ProductVersion)' vs '$pkgVersion'" }
    if (-not $vi.ProductName) { throw 'ProductName empty' }
    Write-Host 'EXE resource check: PASS'
  } else {
    Write-Warning 'EXE resource check skipped (rcedit unavailable).'
  }
} finally {
  Pop-Location
}
