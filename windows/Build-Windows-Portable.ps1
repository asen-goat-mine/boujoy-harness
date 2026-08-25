# Assemble a Windows package scaffold without silently copying a personal vault
# or a macOS runtime. Supply -Vault and -Runtime explicitly only when those
# sources are already safe, Windows-native release inputs.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [string]$Vault = "",
    [string]$Runtime = "",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $destinationRoot = [System.IO.Path]::GetFullPath($Destination)
    New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
    $packageRoot = Join-Path $destinationRoot "Boujoy-Harness-Windows"
    if (Test-Path -LiteralPath $packageRoot) {
        if (-not $Force) { throw "Destination already exists: $packageRoot (pass -Force only after checking this exact folder)" }
        Remove-Item -LiteralPath $packageRoot -Recurse -Force
    }

    $webSource = Join-Path $projectRoot "web"
    $assetsSource = Join-Path $projectRoot "assets"
    $windowsSource = Join-Path $projectRoot "windows"
    foreach ($required in @($webSource, $assetsSource, $windowsSource)) {
        if (-not (Test-Path -LiteralPath $required -PathType Container)) { throw "Missing source directory: $required" }
    }
    $webTarget = Join-Path $packageRoot "app\\web"
    New-Item -ItemType Directory -Force -Path $webTarget, (Join-Path $packageRoot "vault"), (Join-Path $packageRoot "runtime") | Out-Null
    Copy-Item -LiteralPath $webSource -Destination (Join-Path $packageRoot "app") -Recurse -Force
    foreach ($asset in @("punk-collage-bg.png", "punk-collage-dark.png", "fusion-pixel-10px-proportional-zh_hans.otf.woff2")) {
        Copy-Item -LiteralPath (Join-Path $assetsSource $asset) -Destination $webTarget -Force
    }
    Copy-Item -LiteralPath $windowsSource -Destination $packageRoot -Recurse -Force
    # Keep package entry points ASCII-only so Windows Explorer and non-Chinese
    # unzip tools never misdecode the launcher names.
    Copy-Item -LiteralPath (Join-Path $projectRoot "启动 Boujoy Harness.cmd") -Destination (Join-Path $packageRoot "Start-Boujoy.cmd") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "关闭 Boujoy Harness.cmd") -Destination (Join-Path $packageRoot "Stop-Boujoy.cmd") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "Setup-Boujoy.cmd") -Destination (Join-Path $packageRoot "Setup-Boujoy.cmd") -Force
    Copy-Item -LiteralPath (Join-Path $windowsSource "README-Windows.zh-CN.md") -Destination (Join-Path $packageRoot "README-Windows.md") -Force
    Copy-Item -LiteralPath (Join-Path $windowsSource "WINDOWS-RELEASE-STATUS.md") -Destination (Join-Path $packageRoot "RELEASE-STATUS.md") -Force

    if ($Vault) {
        if (-not (Test-Path -LiteralPath $Vault -PathType Container)) { throw "Vault does not exist: $Vault" }
        Get-ChildItem -LiteralPath $Vault -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packageRoot "vault") -Recurse -Force
        }
    } else {
        Set-Content -LiteralPath (Join-Path $packageRoot "vault\\README.md") -Value "Add a local Markdown vault here before launching Boujoy Harness." -Encoding UTF8
    }
    if ($Runtime) {
        if (-not (Test-Path -LiteralPath $Runtime -PathType Container)) { throw "Runtime does not exist: $Runtime" }
        Get-ChildItem -LiteralPath $Runtime -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packageRoot "runtime") -Recurse -Force
        }
    } else {
        Set-Content -LiteralPath (Join-Path $packageRoot "runtime\\README.txt") -Value "Add a Windows x64 DeepSeek Harness runtime here. Never copy the macOS runtime." -Encoding UTF8
    }

    Write-Output "Windows package scaffold created: $packageRoot"
    Write-Output "It is intentionally not marked share-ready until vault and Windows-native runtime checks pass on a real Windows x64 machine."
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
