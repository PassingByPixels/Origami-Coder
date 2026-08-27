# deploy-engine.ps1 - rotate the built engine binary into ~\.origami\bin.
#
# The ONLY thing this script does (deploy ritual, docs/WORKING_ON_ORIGAMI_CODER.md):
#   1. smoke-test the freshly built binary (--version must answer)
#   2. rename the deployed origami.exe aside as origami.exe.prev-<label>  (never deletes)
#   3. copy the built binary in
#   4. smoke-test the deployed copy and print old -> new
#
# It is allowlisted by name in Claude's permission settings so agent sessions can
# deploy without a manual step. Keep it single-purpose: anything beyond the four
# steps above belongs elsewhere and would betray the allowlist's intent.
#
# ASCII only (PS 5.1 reads BOM-less UTF-8 as CP1252).

param(
    [string]$Source = "C:\Repos\Origami Coder\origami-coder.wt\v2-rebase\packages\engine\dist\origami-coder-windows-x64\bin\origami.exe",
    [string]$PrevLabel = ""
)

$ErrorActionPreference = "Stop"
$bin = Join-Path $env:USERPROFILE ".origami\bin"
$target = Join-Path $bin "origami.exe"

if (-not (Test-Path $Source)) { throw "source binary not found: $Source" }

$newVersion = (& $Source --version) 2>$null
if (-not $newVersion) { throw "source binary failed --version smoke test: $Source" }

$oldVersion = "(none)"
if (Test-Path $target) {
    try { $oldVersion = (& $target --version) 2>$null } catch { $oldVersion = "(unreadable)" }
    if (-not $PrevLabel) {
        $PrevLabel = if ($oldVersion -and $oldVersion -ne "(unreadable)") {
            ($oldVersion -replace '[^A-Za-z0-9._-]', '_')
        } else {
            Get-Date -Format "yyyyMMddHHmm"
        }
    }
    $backup = Join-Path $bin ("origami.exe.prev-" + $PrevLabel)
    Move-Item $target $backup -Force
    Write-Host "backed up: $backup"
}

Copy-Item $Source $target
$deployed = (& $target --version) 2>$null
if (-not $deployed) { throw "deployed binary failed --version smoke test - previous binary is at origami.exe.prev-$PrevLabel" }
if ($deployed -ne $newVersion) { throw "deployed version '$deployed' does not match source '$newVersion'" }

Write-Host "engine rotated: $oldVersion -> $deployed"
