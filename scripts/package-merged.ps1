# package-merged.ps1 -- produce a MERGED VSIX: the extension plus the engine
# binary AND a vendored ripgrep for ONE platform, staged into
# packages/vscode/engine/ so vsce packs them; resolveEngineBinary (acpClient.ts)
# spawns the engine bundled-first and bundledRgCandidate hands it the rg.
#
# This script does NOT build anything (the deploy-engine.ps1 lesson: rotating a
# stale artifact is worse than an error). Build the engine for the target
# FIRST, from packages/engine:
#   bun run script/build.ts --single                     (windows-x64, this box)
#   bun run script/build.ts --target=darwin-arm64        (Apple Silicon Mac)
#
# The staged engine/ folder is TRANSIENT: removed in `finally` on every exit,
# so a later plain `npm run package` (the dev, unmerged VSIX) can never pick a
# leftover binary up. It is also gitignored for the same reason.
#
# ASCII only in this file (PS 5.1 reads BOM-less UTF-8 as CP1252).

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('win32-x64', 'darwin-arm64')]
  [string]$Target,

  # Absolute URL vsce rewrites the README's relative image links against.
  # REQUIRED since the README gained images: without a repository field in
  # package.json, vsce refuses relative image links outright. Pass the final
  # hosting root (trailing slash) once one exists.
  [string]$BaseImagesUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vscodeDir = Join-Path $root 'packages\vscode'
$engineDir = Join-Path $root 'packages\engine'

# vsce target -> engine dist folder + binary name
$map = @{
  'win32-x64'    = @{ dist = 'origami-coder-windows-x64'; exe = 'origami.exe' }
  'darwin-arm64' = @{ dist = 'origami-coder-darwin-arm64'; exe = 'origami' }
}
$entry = $map[$Target]
$binary = Join-Path $engineDir ("dist\" + $entry.dist + "\bin\" + $entry.exe)
if (-not (Test-Path $binary)) {
  throw "No engine build for $Target at $binary -- build it first (see header)."
}
$binaryInfo = Get-Item $binary
"engine binary: $($binaryInfo.FullName) ($([math]::Round($binaryInfo.Length / 1MB)) MB, built $($binaryInfo.LastWriteTime))"

# --- ripgrep vendoring ------------------------------------------------------
# The engine's grep/skill tooling hard-requires rg and the fork keeps rg's
# runtime auto-download gated OFF (zero-network product). A fresh machine with
# no rg on PATH therefore bricks the skill tool -- first hit on the macOS
# new-user UAT. The merged VSIX ships rg beside the engine binary; the
# extension points the engine at it via ORIGAMI_RG_PATH (acpClient.ts
# bundledRgCandidate). This download happens HERE, at packaging time on the
# dev box, hash-verified and cached under <family>\vendor\ -- the product
# itself never fetches anything.
$rgVersion = '15.1.0'   # keep in lockstep with packages/core/src/ripgrep/binary.ts VERSION
$rgMap = @{
  'win32-x64'    = @{ platform = 'x86_64-pc-windows-msvc'; ext = 'zip';    rg = 'rg.exe' }
  'darwin-arm64' = @{ platform = 'aarch64-apple-darwin';   ext = 'tar.gz'; rg = 'rg' }
}
$rgEntry = $rgMap[$Target]
$family = Split-Path -Parent (Split-Path -Parent $root)
$vendorDir = Join-Path $family ("vendor\ripgrep\" + $rgVersion + "\" + $Target)
$rgCached = Join-Path $vendorDir $rgEntry.rg
if (-not (Test-Path $rgCached)) {
  $asset = "ripgrep-$rgVersion-" + $rgEntry.platform + "." + $rgEntry.ext
  $url = "https://github.com/BurntSushi/ripgrep/releases/download/$rgVersion/$asset"
  "vendoring ripgrep $rgVersion for ${Target}: $url"
  New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
  $tmpA = Join-Path $vendorDir $asset
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $tmpA
  Invoke-WebRequest -Uri ($url + '.sha256') -OutFile ($tmpA + '.sha256')
  # The sidecar is BSD-format ("SHA256 (file) = hash") -- pull the 64-hex token
  # rather than assuming the coreutils "hash  filename" layout.
  $want = ([regex]::Match((Get-Content ($tmpA + '.sha256') -Raw), '[0-9a-fA-F]{64}')).Value.ToUpper()
  if (-not $want) { throw "could not parse a sha256 out of the sidecar for $asset" }
  $got = (Get-FileHash $tmpA -Algorithm SHA256).Hash.ToUpper()
  if ($want -ne $got) { throw "ripgrep download hash mismatch: want $want got $got" }
  $extractDir = Join-Path $vendorDir 'extract'
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  if ($rgEntry.ext -eq 'zip') {
    Expand-Archive -LiteralPath $tmpA -DestinationPath $extractDir -Force
  } else {
    tar -xzf $tmpA -C $extractDir
    if ($LASTEXITCODE -ne 0) { throw "tar extract failed with exit $LASTEXITCODE" }
  }
  $inner = Join-Path $extractDir ("ripgrep-$rgVersion-" + $rgEntry.platform + "\" + $rgEntry.rg)
  if (-not (Test-Path $inner)) { throw "rg not found in archive at $inner" }
  Copy-Item $inner $rgCached
  Remove-Item -Recurse -Force $extractDir
  Remove-Item -Force $tmpA
  Remove-Item -Force ($tmpA + '.sha256')
}
$rgInfo = Get-Item $rgCached
"ripgrep:       $($rgInfo.FullName) ($([math]::Round($rgInfo.Length / 1MB, 1)) MB)"

$stage = Join-Path $vscodeDir 'engine'
try {
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item $binary (Join-Path $stage $entry.exe)
  Copy-Item $rgCached (Join-Path $stage $rgEntry.rg)

  Push-Location $vscodeDir
  try {
    $vsceArgs = @('vsce', 'package', '--no-dependencies', '--target', $Target)
    if ($BaseImagesUrl) { $vsceArgs += @('--baseImagesUrl', $BaseImagesUrl) }
    npx @vsceArgs
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed with exit $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $vsix = Get-ChildItem $vscodeDir -Filter "*$Target*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $vsix) { throw "packaged, but no *$Target*.vsix found in $vscodeDir" }
  $hash = (Get-FileHash $vsix.FullName -Algorithm SHA256).Hash
  ""
  "merged VSIX: $($vsix.FullName) ($([math]::Round($vsix.Length / 1MB)) MB)"
  "sha256:      $hash"
} finally {
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}
