[CmdletBinding()]
param(
    [string]$Root = "",
    [switch]$SkipRuntimeInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-Application {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command -and $command.Path) { return $command.Path }
    }
    return $null
}

try {
    if ($env:OS -ne "Windows_NT") { throw "This guided setup must run on Windows 10/11 x64." }
    if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $PSScriptRoot }
    $rootPath = (Resolve-Path -LiteralPath $Root).Path
    $vault = Join-Path $rootPath "vault"
    New-Item -ItemType Directory -Force -Path $vault | Out-Null
    $vaultReadme = Join-Path $vault "README.md"
    if (-not (Test-Path -LiteralPath $vaultReadme -PathType Leaf)) {
        Set-Content -LiteralPath $vaultReadme -Encoding UTF8 -Value "# Boujoy Vault`r`n`r`nLocal Markdown workspace for Boujoy Harness.`r`n"
    }

    $node = Find-Application -Names @("node.exe", "node")
    $python = Find-Application -Names @("python.exe", "python")
    if (-not $node) { throw "Node.js LTS was not found. Install it from https://nodejs.org/ and run Setup-Boujoy.cmd again." }
    if (-not $python) { throw "Python 3 was not found. Install it from https://www.python.org/downloads/windows/ and run Setup-Boujoy.cmd again." }

    $dshCommand = Join-Path $rootPath "runtime\DeepSeekHarness\node_modules\.bin\dsh.cmd"
    if (-not (Test-Path -LiteralPath $dshCommand -PathType Leaf)) {
        if ($SkipRuntimeInstall) { throw "DeepSeek Harness runtime is missing: $dshCommand" }
        Write-Host "Installing the Windows DeepSeek Harness runtime..." -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot "Prepare-Windows-Runtime.ps1") -Root $rootPath -Node $node -Python $python
        if ($LASTEXITCODE -ne 0) { throw "DeepSeek Harness runtime preparation failed." }
    }

    & (Join-Path $PSScriptRoot "Start-Boujoy.ps1") -Root $rootPath -Check
    if ($LASTEXITCODE -ne 0) { throw "Boujoy startup check failed." }
    Write-Host "" 
    Write-Host "Boujoy Harness is ready. Double-click Start-Boujoy.cmd to open it." -ForegroundColor Green
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
