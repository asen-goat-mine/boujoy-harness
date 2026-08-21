# Prepare a Windows-native DeepSeek Harness runtime for a Boujoy package.
# Run this on Windows only. It intentionally installs the upstream runtime on
# that platform so platform-specific modules (node-pty, sharp, native dialogs)
# are the correct Windows x64 variants.

[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$Node = "",
    [string]$Python = "",
    [string]$DshVersion = "0.1.1-rc.2"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-Application {
    param([string]$Requested, [string[]]$Names)
    if ($Requested) {
        if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) { throw "Executable does not exist: $Requested" }
        return (Resolve-Path -LiteralPath $Requested).Path
    }
    foreach ($name in $Names) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command -and $command.Path) { return $command.Path }
    }
    return $null
}

try {
    if ($env:OS -ne "Windows_NT") { throw "This runtime preparation script must run on Windows." }
    if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $PSScriptRoot }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Boujoy package root does not exist: $Root" }
    $rootPath = (Resolve-Path -LiteralPath $Root).Path
    $nodeExe = Find-Application -Requested $Node -Names @("node.exe", "node")
    $pythonExe = Find-Application -Requested $Python -Names @("python.exe", "python")
    if (-not $nodeExe) { throw "Install Node.js LTS first, or pass -Node with the full node.exe path." }
    if (-not $pythonExe) { throw "Install Python 3 first, or pass -Python with the full python.exe path." }
    & $nodeExe "--version"
    if ($LASTEXITCODE -ne 0) { throw "node.exe could not run: $nodeExe" }
    & $pythonExe "--version"
    if ($LASTEXITCODE -ne 0) { throw "python.exe could not run: $pythonExe" }

    $nodeDirectory = Split-Path -Parent $nodeExe
    $npmCandidate = Join-Path $nodeDirectory "npm.cmd"
    $npm = if (Test-Path -LiteralPath $npmCandidate -PathType Leaf) {
        $npmCandidate
    } else {
        Find-Application -Requested "" -Names @("npm.cmd", "npm")
    }
    if (-not $npm) { throw "npm.cmd was not found next to Node. Install a complete Node.js LTS package." }

    $runtimeRoot = Join-Path $rootPath "runtime"
    $dshRoot = Join-Path $runtimeRoot "DeepSeekHarness"
    New-Item -ItemType Directory -Force -Path $dshRoot, (Join-Path $dshRoot "home"), (Join-Path $dshRoot "clean-home") | Out-Null
    $packageJson = Join-Path $dshRoot "package.json"
    $package = [ordered]@{
        private = $true
        dependencies = [ordered]@{ "@deepseek-ai/dsh" = $DshVersion }
    }
    $package | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $packageJson -Encoding UTF8

    $previousPath = $env:PATH
    $env:PATH = $nodeDirectory + ";" + $env:PATH
    try {
        Push-Location $dshRoot
        & $npm "install" "--omit=dev" "--no-audit" "--no-fund"
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
        $env:PATH = $previousPath
    }
    $dshCommand = Join-Path $dshRoot "node_modules\\.bin\\dsh.cmd"
    if (-not (Test-Path -LiteralPath $dshCommand -PathType Leaf)) { throw "npm completed but dsh.cmd was not created: $dshCommand" }

    Write-Output "Windows DeepSeek Harness runtime is ready: $dshRoot"
    Write-Output "The launcher will use system node.exe/python.exe. For a fully portable bundle, place Windows x64 Node and Python runtimes under runtime\\node and runtime\\python before distribution."
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
