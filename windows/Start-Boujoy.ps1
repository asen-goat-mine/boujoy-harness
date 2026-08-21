# Boujoy Harness Windows local host.
# This script intentionally owns the local Python gateway and both DeepSeek
# Harness modes. It does not alter the web UI; Edge/Chrome render the exact
# same product page served at http://127.0.0.1:8766.

[CmdletBinding()]
param(
    [string]$Root = "",
    [switch]$Check,
    [switch]$SkipRuntimeProbe,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:StateDirectory = $null
$script:HostLog = $null
$script:StateFile = $null
$script:RestartFile = $null

function Get-FirstExecutable {
    param(
        [string[]]$Candidates,
        [string[]]$Commands
    )

    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    foreach ($commandName in $Commands) {
        $command = Get-Command -Name $commandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command -and $command.Path -and (Test-Path -LiteralPath $command.Path -PathType Leaf)) {
            return $command.Path
        }
    }
    return $null
}

function Resolve-BoujoyLayout {
    param([string]$RequestedRoot)

    if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
        $RequestedRoot = Split-Path -Parent $PSScriptRoot
    }
    if (-not (Test-Path -LiteralPath $RequestedRoot -PathType Container)) {
        throw "Boujoy package root does not exist: $RequestedRoot"
    }
    $packageRoot = (Resolve-Path -LiteralPath $RequestedRoot).Path
    $appRoot = if (Test-Path -LiteralPath (Join-Path $packageRoot "app\\web\\boujoy_server.py") -PathType Leaf) {
        Join-Path $packageRoot "app"
    } else {
        $packageRoot
    }
    $static = Join-Path $appRoot "web"
    $runtime = Join-Path $packageRoot "runtime"
    $dshRoot = Join-Path $runtime "DeepSeekHarness"
    $node = Get-FirstExecutable -Candidates @(
        (Join-Path $runtime "node\\node.exe"),
        (Join-Path $runtime "node.exe")
    ) -Commands @("node.exe", "node")
    $python = Get-FirstExecutable -Candidates @(
        (Join-Path $runtime "python\\python.exe"),
        (Join-Path $runtime "python.exe")
    ) -Commands @("python.exe", "python")

    [pscustomobject]@{
        Root = $packageRoot
        Static = $static
        Vault = Join-Path $packageRoot "vault"
        Runtime = $runtime
        DshRoot = $dshRoot
        DshCommand = Join-Path $dshRoot "node_modules\\.bin\\dsh.cmd"
        KnowledgeHome = Join-Path $dshRoot "home"
        CleanHome = Join-Path $dshRoot "clean-home"
        Gateway = Join-Path $static "boujoy_server.py"
        Node = $node
        NodeDirectory = if ($node) { Split-Path -Parent $node } else { $null }
        Python = $python
    }
}

function Test-BoujoyLayout {
    param(
        [pscustomobject]$Layout,
        [switch]$SkipProbe
    )

    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($item in @(
        @{ Label = "vault"; Path = $Layout.Vault; Kind = "Container" },
        @{ Label = "Boujoy web gateway"; Path = $Layout.Gateway; Kind = "Leaf" },
        @{ Label = "DeepSeek Harness runtime"; Path = $Layout.DshRoot; Kind = "Container" },
        @{ Label = "Windows dsh.cmd"; Path = $Layout.DshCommand; Kind = "Leaf" }
    )) {
        if (-not (Test-Path -LiteralPath $item.Path -PathType $item.Kind)) {
            $missing.Add("$($item.Label): $($item.Path)")
        }
    }
    if (-not $Layout.Node) { $missing.Add("node.exe (runtime/node/node.exe or PATH)") }
    if (-not $Layout.Python) { $missing.Add("python.exe (runtime/python/python.exe or PATH)") }
    if ($missing.Count -gt 0) {
        $detail = $missing -join [Environment]::NewLine
        throw "Windows runtime is incomplete:`n$detail`n`nDo not copy the macOS runtime into this package. Build/install the Windows x64 DeepSeek Harness runtime first."
    }
    if (-not $SkipProbe) {
        & $Layout.Node "--version" *> $null
        if ($LASTEXITCODE -ne 0) { throw "node.exe could not run: $($Layout.Node)" }
        & $Layout.Python "--version" *> $null
        if ($LASTEXITCODE -ne 0) { throw "python.exe could not run: $($Layout.Python)" }
    }
}

function Get-BoujoyStateDirectory {
    param([string]$PackageRoot)

    $base = if ($env:LOCALAPPDATA) {
        $env:LOCALAPPDATA
    } else {
        Join-Path $HOME "AppData\\Local"
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($PackageRoot.ToLowerInvariant())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
    return (Join-Path $base ("Boujoy\\BoujoyHarness\\Windows\\" + $hash.Substring(0, 16)))
}

function Write-BoujoyHostLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $script:HostLog -Value $line -Encoding UTF8
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    # Windows paths cannot contain a double quote. Quoting every argument
    # therefore safely preserves spaces and Chinese characters in package
    # paths for Start-Process on both Windows PowerShell 5.1 and PowerShell 7.
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-BoujoyChild {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment,
        [string]$StateDirectory
    )

    $previous = @{}
    foreach ($key in $Environment.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
    }
    try {
        $argumentText = ($Arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join " "
        $stdout = Join-Path $StateDirectory ("$Name.stdout.log")
        $stderr = Join-Path $StateDirectory ("$Name.stderr.log")
        $process = Start-Process -FilePath $FilePath -ArgumentList $argumentText -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        return [pscustomobject]@{ Name = $Name; Process = $process; Stdout = $stdout; Stderr = $stderr }
    } finally {
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
        }
    }
}

function Test-BoujoyEndpoint {
    param([string]$Url)
    try {
        $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = 900
        $request.ReadWriteTimeout = 900
        $response = $request.GetResponse()
        try {
            return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500)
        } finally {
            $response.Close()
        }
    } catch [System.Net.WebException] {
        # DeepSeek Harness can return a local 4xx while its web host is already
        # listening (for example a root-path route variation). Match the macOS
        # host's readiness rule: any completed local HTTP response below 500
        # proves that this port is owned by a live service.
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try {
                return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500)
            } finally {
                $response.Close()
            }
        }
        return $false
    } catch {
        return $false
    }
}

function Wait-BoujoyEndpoint {
    param([string]$Label, [string]$Url, [int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempt = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-BoujoyEndpoint $Url) { return }
        $delay = if ($attempt -lt 50) { 100 } elseif ($attempt -lt 130) { 250 } else { 500 }
        Start-Sleep -Milliseconds $delay
        $attempt += 1
    }
    throw "$Label did not become ready within $TimeoutSeconds seconds. See $script:StateDirectory for logs."
}

function Stop-BoujoyProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    try {
        & taskkill.exe /PID "$ProcessId" /T /F *> $null
    } catch {}
}

function Stop-BoujoyChildren {
    param([object[]]$Children)
    foreach ($child in @($Children)) {
        if ($null -ne $child -and $null -ne $child.Process) {
            Stop-BoujoyProcessTree -ProcessId ([int]$child.Process.Id)
        }
    }
}

function Get-BoujoyProcessStartTicks {
    param([System.Diagnostics.Process]$Process)
    try {
        return $Process.StartTime.ToUniversalTime().Ticks
    } catch {
        # The process object is only ever persisted after its readiness check.
        # A zero value keeps the state format explicit if Windows denies this
        # metadata; the external stop command will refuse such an unsafe PID.
        return [Int64]0
    }
}

function Save-BoujoyState {
    param([pscustomobject]$Layout, [object[]]$Children)
    $payload = [ordered]@{
        root = $Layout.Root
        hostPid = $PID
        hostStartTicks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
        processes = @($Children | ForEach-Object {
            [ordered]@{
                name = $_.Name
                pid = $_.Process.Id
                startTicks = Get-BoujoyProcessStartTicks -Process $_.Process
                stdout = $_.Stdout
                stderr = $_.Stderr
            }
        })
    }
    $temporary = "$script:StateFile.tmp"
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $script:StateFile -Force
}

function Open-BoujoyBrowser {
    $url = "http://127.0.0.1:8766/"
    $candidates = New-Object System.Collections.Generic.List[string]
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "Microsoft\\Edge\\Application\\msedge.exe")) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles "Microsoft\\Edge\\Application\\msedge.exe")) }
    foreach ($edge in $candidates) {
        if (Test-Path -LiteralPath $edge -PathType Leaf) {
            Start-Process -FilePath $edge -ArgumentList ("--app=" + $url)
            return
        }
    }
    Start-Process $url
}

function Prepare-BoujoyHomes {
    param([pscustomobject]$Layout)
    New-Item -ItemType Directory -Force -Path $Layout.KnowledgeHome, $Layout.CleanHome | Out-Null
    $sourceCredential = Join-Path $Layout.KnowledgeHome ".credentials.yaml"
    $cleanCredential = Join-Path $Layout.CleanHome ".credentials.yaml"
    if ((Test-Path -LiteralPath $sourceCredential -PathType Leaf) -and -not (Test-Path -LiteralPath $cleanCredential -PathType Leaf)) {
        Copy-Item -LiteralPath $sourceCredential -Destination $cleanCredential
    }
}

function Start-BoujoyServices {
    param([pscustomobject]$Layout)

    Remove-Item -LiteralPath $script:RestartFile -Force -ErrorAction SilentlyContinue
    Prepare-BoujoyHomes -Layout $Layout
    $children = New-Object System.Collections.Generic.List[object]
    $commonEnvironment = @{
        "BOUJOY_DSH_ROOT" = $Layout.DshRoot
        "DSH_TELEMETRY_DISABLED" = "1"
        "PATH" = $Layout.NodeDirectory + ";" + $env:PATH
    }
    try {
        $knowledgeEnvironment = @{} + $commonEnvironment
        $knowledgeEnvironment["DSH_HOME"] = $Layout.KnowledgeHome
        $children.Add((Start-BoujoyChild -Name "knowledge" -FilePath $Layout.DshCommand `
            -Arguments @("web", "--host", "127.0.0.1", "--port", "3080", "--no-open") -WorkingDirectory $Layout.Vault `
            -Environment $knowledgeEnvironment -StateDirectory $script:StateDirectory))

        # macOS starts the clean engine lazily through its native bridge. The
        # browser host has no bridge, so keep the two local modes ready from
        # launch; the UI and its mode semantics remain unchanged.
        $cleanEnvironment = @{} + $commonEnvironment
        $cleanEnvironment["DSH_HOME"] = $Layout.CleanHome
        $children.Add((Start-BoujoyChild -Name "clean" -FilePath $Layout.DshCommand `
            -Arguments @("web", "--host", "127.0.0.1", "--port", "3081", "--no-open") -WorkingDirectory $env:USERPROFILE `
            -Environment $cleanEnvironment -StateDirectory $script:StateDirectory))

        $gatewayEnvironment = @{ "PYTHONDONTWRITEBYTECODE" = "1"; "BOUJOY_DEBUG" = "0" }
        $children.Add((Start-BoujoyChild -Name "gateway" -FilePath $Layout.Python `
            -Arguments @($Layout.Gateway, "--port", "8766", "--vault", $Layout.Vault, "--static", $Layout.Static,
                "--knowledge-home", $Layout.KnowledgeHome, "--clean-home", $Layout.CleanHome, "--restart-file", $script:RestartFile) `
            -WorkingDirectory $Layout.Static -Environment $gatewayEnvironment -StateDirectory $script:StateDirectory))

        Wait-BoujoyEndpoint -Label "Knowledge Harness" -Url "http://127.0.0.1:3080/"
        Wait-BoujoyEndpoint -Label "Clean Harness" -Url "http://127.0.0.1:3081/"
        Wait-BoujoyEndpoint -Label "Boujoy gateway" -Url "http://127.0.0.1:8766/api/health"
        Save-BoujoyState -Layout $Layout -Children $children.ToArray()
        return @($children.ToArray())
    } catch {
        Stop-BoujoyChildren -Children $children.ToArray()
        throw
    }
}

function Show-BoujoyFailure {
    param([string]$Message)
    if ($env:OS -ne "Windows_NT") { return }
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($Message, "Boujoy Harness startup failed") | Out-Null
    } catch {}
}

try {
    if (-not $Check -and $env:OS -ne "Windows_NT") {
        throw "This launcher must run on Windows."
    }
    $layout = Resolve-BoujoyLayout -RequestedRoot $Root
    Test-BoujoyLayout -Layout $layout -SkipProbe:$SkipRuntimeProbe
    if ($Check) {
        Write-Output "Boujoy Windows launcher check passed: $($layout.Root)"
        return
    }

    $script:StateDirectory = Get-BoujoyStateDirectory -PackageRoot $layout.Root
    New-Item -ItemType Directory -Force -Path $script:StateDirectory | Out-Null
    $script:HostLog = Join-Path $script:StateDirectory "host.log"
    $script:StateFile = Join-Path $script:StateDirectory "processes.json"
    $script:RestartFile = Join-Path $script:StateDirectory "restart.request"

    if (Test-BoujoyEndpoint "http://127.0.0.1:8766/api/health") {
        Write-BoujoyHostLog "An existing Boujoy gateway is already healthy; opening it without starting a duplicate host."
        if (-not $NoBrowser) { Open-BoujoyBrowser }
        return
    }

    do {
        $restartRequested = $false
        $children = @(Start-BoujoyServices -Layout $layout)
        Write-BoujoyHostLog "Boujoy Windows host started."
        if (-not $NoBrowser) { Open-BoujoyBrowser }
        while ($true) {
            if (Test-Path -LiteralPath $script:RestartFile -PathType Leaf) {
                Remove-Item -LiteralPath $script:RestartFile -Force -ErrorAction SilentlyContinue
                $restartRequested = $true
                Write-BoujoyHostLog "Managed restart requested."
                break
            }
            $dead = @($children | Where-Object { $_.Process.HasExited })
            if ($dead.Count -gt 0) {
                throw ("A local Boujoy service exited unexpectedly: " + (($dead | ForEach-Object { $_.Name }) -join ", "))
            }
            Start-Sleep -Milliseconds 250
        }
        Stop-BoujoyChildren -Children $children
    } while ($restartRequested)
} catch {
    $message = $_.Exception.Message
    if ($script:HostLog) { Write-BoujoyHostLog "ERROR: $message" }
    Show-BoujoyFailure -Message ($message + "`n`nSee the local Boujoy Windows logs for details.")
    Write-Error $message
    exit 1
} finally {
    if ($script:StateFile) {
        Remove-Item -LiteralPath $script:StateFile -Force -ErrorAction SilentlyContinue
    }
}
