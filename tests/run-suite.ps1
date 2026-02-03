param(
  [switch]$LoadEnv,
  [string]$BaseUrl = 'http://localhost:3000',
  [int]$ServerPort = 3000,
  [string]$IdentityMappingPolicy = 'vendor',
  [string]$ChecktypeMap = '{"I":"IN","O":"OUT","0":"IN","1":"OUT"}',
  [switch]$NoServer,
  [int]$ServerStartTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('LoadEnv')) {
  $LoadEnv = $true
}

$script:StartedServer = $false
$script:ServerProcess = $null
$script:ServerStdoutLogPath = $null
$script:ServerStderrLogPath = $null
$script:HadAllowTestEndpoints = $false
$script:AllowTestEndpointsPrev = $null
$script:HadIdentityPolicy = $false
$script:IdentityPolicyPrev = $null
$script:HadChecktypeMap = $false
$script:ChecktypeMapPrev = $null
$script:HadBaseUrl = $false
$script:BaseUrlPrev = $null
$script:HadPort = $false
$script:PortPrev = $null

function Write-Section([string]$title) {
  Write-Host ''
  Write-Host ('==== ' + $title + ' ====')
}

function Fail-Step([string]$label, [string]$detail) {
  Write-Host ('RUN SUITE FAIL: ' + $label)
  if ($detail) {
    Write-Host $detail
  }
  exit 1
}

function Test-PortOpen([string]$hostName, [int]$portNumber) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($hostName, $portNumber, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1000, $false)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    if ($client) {
      try { $client.Close() } catch {}
    }
    return $false
  }
}

function Write-ServerLogsTail([string]$outPath, [string]$errPath) {
  if ($outPath -and (Test-Path $outPath)) {
    Write-Host '---- server stdout tail ----'
    Get-Content -Path $outPath -Tail 200 | ForEach-Object { Write-Host $_ }
  }
  if ($errPath -and (Test-Path $errPath)) {
    Write-Host '---- server stderr tail ----'
    Get-Content -Path $errPath -Tail 200 | ForEach-Object { Write-Host $_ }
  }
}

function Wait-ForPort([string]$hostName, [int]$portNumber, [int]$timeoutSeconds, [string]$outPath, [string]$errPath) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen $hostName $portNumber) {
      return
    }
    Start-Sleep -Seconds 1
  }
  Write-ServerLogsTail $outPath $errPath
  Fail-Step 'server_ready' ('Server not ready at ' + $hostName + ':' + $portNumber + '. Logs: ' + $outPath + ' | ' + $errPath)
}

try {
  Write-Section 'Prep'

  if ($LoadEnv) {
    $envLoader = Join-Path $PSScriptRoot '..\scripts\db\load-env.ps1'
    if (Test-Path $envLoader) {
      Write-Host 'Loading PG env vars from .env'
      . $envLoader
    } else {
      Write-Host 'PG env loader not found; skipping.'
    }
  }

  $script:HadAllowTestEndpoints = $null -ne $env:ALLOW_TEST_ENDPOINTS
  $script:AllowTestEndpointsPrev = $env:ALLOW_TEST_ENDPOINTS
  $script:HadIdentityPolicy = $null -ne $env:IDENTITY_MAPPING_POLICY
  $script:IdentityPolicyPrev = $env:IDENTITY_MAPPING_POLICY
  $script:HadChecktypeMap = $null -ne $env:ZKTECO_CHECKTYPE_MAP
  $script:ChecktypeMapPrev = $env:ZKTECO_CHECKTYPE_MAP
  $script:HadBaseUrl = $null -ne $env:BASE_URL
  $script:BaseUrlPrev = $env:BASE_URL
  $script:HadPort = $null -ne $env:PORT
  $script:PortPrev = $env:PORT

  $env:ALLOW_TEST_ENDPOINTS = 'true'
  $env:IDENTITY_MAPPING_POLICY = $IdentityMappingPolicy
  $env:ZKTECO_CHECKTYPE_MAP = $ChecktypeMap
  $env:BASE_URL = $BaseUrl
  $env:PORT = $ServerPort

  $serverHost = $null
  try {
    $serverHost = ([Uri]$BaseUrl).Host
  } catch {
    $serverHost = 'localhost'
  }
  if (-not $serverHost) {
    $serverHost = 'localhost'
  }

  if (-not $NoServer) {
    Write-Section 'Server'
    $isListening = Test-PortOpen $serverHost $ServerPort
    if (-not $isListening) {
      Write-Host 'Starting server with ALLOW_TEST_ENDPOINTS=true'
      $tmpDir = Join-Path $PSScriptRoot '.tmp'
      if (-not (Test-Path $tmpDir)) {
        New-Item -Path $tmpDir -ItemType Directory | Out-Null
      }
      $script:ServerStdoutLogPath = Join-Path $tmpDir 'run-suite-server.out.log'
      $script:ServerStderrLogPath = Join-Path $tmpDir 'run-suite-server.err.log'

      try {
        $script:ServerProcess = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
          -WorkingDirectory (Join-Path $PSScriptRoot '..') `
          -RedirectStandardOutput $script:ServerStdoutLogPath `
          -RedirectStandardError $script:ServerStderrLogPath `
          -NoNewWindow `
          -PassThru
      } catch {
        $script:ServerProcess = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
          -WorkingDirectory (Join-Path $PSScriptRoot '..') `
          -RedirectStandardOutput $script:ServerStdoutLogPath `
          -RedirectStandardError $script:ServerStderrLogPath `
          -PassThru
      }
      $script:StartedServer = $true

      Wait-ForPort $serverHost $ServerPort $ServerStartTimeoutSeconds $script:ServerStdoutLogPath $script:ServerStderrLogPath
    } else {
      Write-Host 'Server already running, skip start'
    }

    Write-Section 'Server Mode'
    try {
      Invoke-RestMethod -Uri ($BaseUrl + '/api/ops/test/mode') -TimeoutSec 5 | Out-Null
      Write-Host 'Server mode endpoint OK'
    } catch {
      Write-ServerLogsTail $script:ServerStdoutLogPath $script:ServerStderrLogPath
      Fail-Step 'server_mode' 'Failed to fetch /api/ops/test/mode. Is the test server running with ALLOW_TEST_ENDPOINTS=true?'
    }
  }

  Write-Section 'Run Tests'
  & (Join-Path $PSScriptRoot 'run-all.ps1')
  if ($LASTEXITCODE -ne 0) {
    Fail-Step 'tests' ('run-all.ps1 failed with exit code ' + $LASTEXITCODE)
  }

  Write-Host ''
  Write-Host 'RUN SUITE PASS'
  exit 0
} finally {
  if ($script:HadAllowTestEndpoints) {
    $env:ALLOW_TEST_ENDPOINTS = $script:AllowTestEndpointsPrev
  } else {
    Remove-Item Env:ALLOW_TEST_ENDPOINTS -ErrorAction SilentlyContinue
  }
  if ($script:HadIdentityPolicy) {
    $env:IDENTITY_MAPPING_POLICY = $script:IdentityPolicyPrev
  } else {
    Remove-Item Env:IDENTITY_MAPPING_POLICY -ErrorAction SilentlyContinue
  }
  if ($script:HadChecktypeMap) {
    $env:ZKTECO_CHECKTYPE_MAP = $script:ChecktypeMapPrev
  } else {
    Remove-Item Env:ZKTECO_CHECKTYPE_MAP -ErrorAction SilentlyContinue
  }
  if ($script:HadBaseUrl) {
    $env:BASE_URL = $script:BaseUrlPrev
  } else {
    Remove-Item Env:BASE_URL -ErrorAction SilentlyContinue
  }
  if ($script:HadPort) {
    $env:PORT = $script:PortPrev
  } else {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
  }
  if ($script:StartedServer -and $script:ServerProcess) {
    try {
      Stop-Process -Id $script:ServerProcess.Id -Force
    } catch {
    }
  }
}
