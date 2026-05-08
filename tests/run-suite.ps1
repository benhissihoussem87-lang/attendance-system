param(
  [switch]$LoadEnv,
  [string]$BaseUrl = 'http://localhost:3000',
  [int]$ServerPort = 3000,
  [string]$IdentityMappingPolicy = 'vendor',
  [string]$ChecktypeMap = '{"I":"IN","O":"OUT","0":"IN","1":"OUT"}',
  [switch]$NoServer,
  [switch]$UseExistingServer,
  [int]$ServerStartTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('LoadEnv')) {
  $LoadEnv = $true
}

$repoRoot = Split-Path -Parent $PSScriptRoot
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
$script:HadUseIdentityMappings = $false
$script:UseIdentityMappingsPrev = $null
$script:HadRequireIdentityMappings = $false
$script:RequireIdentityMappingsPrev = $null
$script:HadUseEmployeesRegistry = $false
$script:UseEmployeesRegistryPrev = $null
$script:HadUseEmployeeAssignments = $false
$script:UseEmployeeAssignmentsPrev = $null
$script:HadBaseUrl = $false
$script:BaseUrlPrev = $null
$script:HadPort = $false
$script:PortPrev = $null
$script:HadCiRunId = $false
$script:CiRunIdPrev = $null
$script:HadSeedProfile = $false
$script:SeedProfilePrev = $null

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

function Get-ServerModeWithRetry([string]$baseUrl, [int]$timeoutSeconds) {
  $apiKey = Resolve-TestApiKey
  $headers = $null
  if ($apiKey) {
    $headers = @{ 'x-api-key' = $apiKey }
  }
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      if ($headers) {
        return Invoke-RestMethod -Uri ($baseUrl + '/api/ops/test/mode') -TimeoutSec 5 -Headers $headers
      }
      return Invoke-RestMethod -Uri ($baseUrl + '/api/ops/test/mode') -TimeoutSec 5
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $null
}

function Resolve-TestApiKey() {
  $candidates = @(
    $env:TEST_API_KEY_ADMIN,
    $env:TEST_API_KEY_OPERATOR,
    $env:API_KEY
  )
  foreach ($candidate in $candidates) {
    if ($candidate) {
      $value = $candidate.ToString().Trim()
      if ($value) {
        return $value
      }
    }
  }
  return ''
}

function Try-GetHttpStatus([string]$url) {
  $apiKey = Resolve-TestApiKey
  $headers = $null
  if ($apiKey) {
    $headers = @{ 'x-api-key' = $apiKey }
  }
  $supportsSkipHttpErrorCheck = $false
  try {
    $invokeWebRequest = Get-Command Invoke-WebRequest -ErrorAction Stop
    $supportsSkipHttpErrorCheck = $invokeWebRequest.Parameters.ContainsKey('SkipHttpErrorCheck')
  } catch {
  }

  if ($supportsSkipHttpErrorCheck) {
    try {
      if ($headers) {
        $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 5 -SkipHttpErrorCheck -Headers $headers
      } else {
        $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 5 -SkipHttpErrorCheck
      }
      $status = $null
      try { $status = [int]$response.StatusCode } catch {}
      $body = $null
      try { $body = $response.Content } catch {}
      return @{
        ok = ($status -ge 200 -and $status -lt 300)
        status = $status
        body = $body
      }
    } catch {
    }
  }

  try {
    if ($headers) {
      $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 5 -Headers $headers -ErrorAction Stop
    } else {
      $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 5 -ErrorAction Stop
    }
    $status = $null
    try { $status = [int]$response.StatusCode } catch {}
    $body = $null
    try { $body = $response.Content } catch {}
    return @{
      ok = $true
      status = $status
      body = $body
    }
  } catch {
    $status = $null
    $body = $null

    try {
      $resp = $_.Exception.Response
      if ($resp) {
        try { $status = [int]$resp.StatusCode } catch {}
        try {
          if ($resp.Content) {
            $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
          }
        } catch {}
        if (-not $body) {
          try {
            $stream = $resp.GetResponseStream()
            if ($stream) {
              $reader = New-Object System.IO.StreamReader($stream)
              $body = $reader.ReadToEnd()
            }
          } catch {}
        }
      }
    } catch {
    }

    if (-not $body) {
      try {
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
          $body = $_.ErrorDetails.Message
        }
      } catch {
      }
    }

    return @{
      ok = $false
      status = $status
      body = $body
    }
  }
}

try {
  Write-Section 'Prep'

  if ($LoadEnv) {
    $envLoader = Join-Path $repoRoot 'scripts\db\load-env.ps1'
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
  $script:HadUseIdentityMappings = $null -ne $env:USE_IDENTITY_MAPPINGS
  $script:UseIdentityMappingsPrev = $env:USE_IDENTITY_MAPPINGS
  $script:HadRequireIdentityMappings = $null -ne $env:REQUIRE_IDENTITY_MAPPINGS
  $script:RequireIdentityMappingsPrev = $env:REQUIRE_IDENTITY_MAPPINGS
  $script:HadUseEmployeesRegistry = $null -ne $env:USE_EMPLOYEES_REGISTRY
  $script:UseEmployeesRegistryPrev = $env:USE_EMPLOYEES_REGISTRY
  $script:HadUseEmployeeAssignments = $null -ne $env:USE_EMPLOYEE_ASSIGNMENTS
  $script:UseEmployeeAssignmentsPrev = $env:USE_EMPLOYEE_ASSIGNMENTS
  $script:HadBaseUrl = $null -ne $env:BASE_URL
  $script:BaseUrlPrev = $env:BASE_URL
  $script:HadPort = $null -ne $env:PORT
  $script:PortPrev = $env:PORT
  $script:HadCiRunId = $null -ne $env:CI_RUN_ID
  $script:CiRunIdPrev = $env:CI_RUN_ID
  $script:HadSeedProfile = $null -ne $env:SEED_PROFILE
  $script:SeedProfilePrev = $env:SEED_PROFILE

  $ciValue = if ($env:CI) { $env:CI.ToString().Trim().ToLower() } else { '' }
  $ciEnabled = ($ciValue -eq '1' -or $ciValue -eq 'true')
  $isCiRun = ($ciEnabled -or [bool]$env:GITHUB_RUN_ID)
  if ($isCiRun) {
    $seedProfileCurrent = if ($env:SEED_PROFILE) { $env:SEED_PROFILE.ToString().Trim() } else { '' }
    if (-not $seedProfileCurrent) {
      $env:SEED_PROFILE = 'ci'
    }
  }
  $isLocalRun = (-not $ciEnabled -and -not $env:GITHUB_RUN_ID)
  if ($isLocalRun) {
    $ciRunIdCurrent = if ($env:CI_RUN_ID) { $env:CI_RUN_ID.ToString().Trim() } else { '' }
    $shouldRefreshCiRunId = (-not $ciRunIdCurrent) -or `
      $ciRunIdCurrent.StartsWith('local', [System.StringComparison]::OrdinalIgnoreCase) -or `
      ($ciRunIdCurrent.Length -gt 16)
    if ($shouldRefreshCiRunId) {
      $env:CI_RUN_ID = ([guid]::NewGuid().ToString('N')).Substring(0, 8)
    }
  }

  $env:ALLOW_TEST_ENDPOINTS = 'true'
  $env:IDENTITY_MAPPING_POLICY = $IdentityMappingPolicy
  $env:ZKTECO_CHECKTYPE_MAP = $ChecktypeMap
  $env:USE_IDENTITY_MAPPINGS = '1'
  $env:REQUIRE_IDENTITY_MAPPINGS = '1'
  $env:USE_EMPLOYEES_REGISTRY = '1'
  $env:USE_EMPLOYEE_ASSIGNMENTS = '1'
  $env:BASE_URL = $BaseUrl
  $env:PORT = $ServerPort

  Write-Section 'Apply Seeds'
  $seedProfile = if ($env:SEED_PROFILE) { $env:SEED_PROFILE.ToString().Trim() } else { '' }
  if (-not $seedProfile) {
    $seedProfile = 'dev'
  }
  $shouldApplySeeds = $true
  if ($UseExistingServer -and -not $NoServer -and -not $isCiRun -and -not $script:HadSeedProfile) {
    $shouldApplySeeds = $false
    Write-Host 'WARN: Skipping DB seeds because -UseExistingServer was set and SEED_PROFILE was not explicitly provided.'
    Write-Host 'WARN: This prevents seeding against an unknown server/database pairing.'
    Write-Host 'Hint: Set SEED_PROFILE=dev|ci|prod explicitly to opt in seeding with -UseExistingServer.'
    Write-Host "Hint: In PowerShell, set env var first, e.g. `$env:SEED_PROFILE='dev' ; pwsh -NoProfile -File .\tests\run-suite.ps1 -UseExistingServer"
  }
  if ($shouldApplySeeds) {
    $applySeedsScript = Join-Path $repoRoot 'scripts\db\apply-seeds.ps1'
    if (-not (Test-Path $applySeedsScript)) {
      Fail-Step 'seeds' ("Seed script not found: {0}" -f $applySeedsScript)
    }
    Write-Host ("Applying DB seeds with profile '{0}'" -f $seedProfile)
    & $applySeedsScript -Profile $seedProfile -RepoRoot $repoRoot
    if ($LASTEXITCODE -ne 0) {
      Fail-Step 'seeds' ('apply-seeds.ps1 failed with exit code ' + $LASTEXITCODE)
    }
  }

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
      $repoRootResolved = Resolve-Path -LiteralPath $repoRoot
      $tmpDir = Join-Path $PSScriptRoot '.tmp'
      $cleanupTargets = @($tmpDir)
      foreach ($target in $cleanupTargets) {
        try {
          if (Test-Path $target) {
            $resolved = Resolve-Path -LiteralPath $target
            $repoPrefix = $repoRootResolved.Path.TrimEnd('\') + '\'
            $targetPath = $resolved.Path.TrimEnd('\') + '\'
            if ($targetPath.StartsWith($repoPrefix)) {
              Remove-Item -LiteralPath $resolved.Path -Recurse -Force
            } else {
              Write-Host ("WARN: Skipping cleanup for path outside repo root: {0}" -f $resolved.Path)
            }
          }
        } catch {
          Write-Host ("WARN: Failed to cleanup {0}: {1}" -f $target, $_)
        }
      }
      if (-not (Test-Path $tmpDir)) {
        New-Item -Path $tmpDir -ItemType Directory | Out-Null
      }
      $script:ServerStdoutLogPath = Join-Path $tmpDir 'run-suite-server.out.log'
      $script:ServerStderrLogPath = Join-Path $tmpDir 'run-suite-server.err.log'

      try {
        $script:ServerProcess = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
          -WorkingDirectory $repoRoot `
          -RedirectStandardOutput $script:ServerStdoutLogPath `
          -RedirectStandardError $script:ServerStderrLogPath `
          -NoNewWindow `
          -PassThru
      } catch {
        $script:ServerProcess = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
          -WorkingDirectory $repoRoot `
          -RedirectStandardOutput $script:ServerStdoutLogPath `
          -RedirectStandardError $script:ServerStderrLogPath `
          -PassThru
      }
      $script:StartedServer = $true

      Wait-ForPort $serverHost $ServerPort $ServerStartTimeoutSeconds $script:ServerStdoutLogPath $script:ServerStderrLogPath
    } else {
      if (-not $UseExistingServer) {
        Write-Host 'RUN SUITE FAIL: existing server detected'
        Write-Host ("Server already listening on port {0}. Env capture is non-deterministic." -f $ServerPort)
        Write-Host ("Hint: Stop the existing server on port {0} and rerun: .\\tests\\run-suite.ps1" -f $ServerPort)
        Write-Host 'Hint: Or rerun with -UseExistingServer to accept non-deterministic env capture'
        exit 1
      }
      Write-Host 'WARN: Server already running; env capture is non-deterministic (ALLOW_TEST_ENDPOINTS, IDENTITY_MAPPING_POLICY, ZKTECO_CHECKTYPE_MAP).'
    }

    Write-Section 'Server Mode'
    $mode = Get-ServerModeWithRetry $BaseUrl 10
    if ($mode) {
      Write-Host 'Server mode endpoint OK'
      if ($isListening) {
        $policy = if ($mode.identity_mapping_policy) { $mode.identity_mapping_policy } else { '' }
        $policy = $policy.ToString().Trim().ToLower()
        $expectedPolicy = $IdentityMappingPolicy.ToString().Trim().ToLower()
        if (-not $mode.allow_test_endpoints -or $policy -ne $expectedPolicy) {
          Write-Host 'RUN SUITE FAIL: server mode mismatch'
          Write-Host ("allow_test_endpoints expected=true actual={0}" -f $mode.allow_test_endpoints)
          Write-Host ("identity_mapping_policy expected={0} actual={1}" -f $expectedPolicy, $policy)
          Write-Host 'Hint: Stop the existing server and rerun: .\tests\run-suite.ps1'
          Write-Host 'Hint: Or start test-safe server: .\scripts\run-test-server.ps1'
          exit 1
        }
      }
    } else {
      Write-ServerLogsTail $script:ServerStdoutLogPath $script:ServerStderrLogPath
      $modeProbe = Try-GetHttpStatus ($BaseUrl + '/api/ops/test/mode')
      $probeBodyText = if ($modeProbe.body) { $modeProbe.body.ToString().ToLower() } else { '' }
      $resolvedModeApiKey = Resolve-TestApiKey
      if ($modeProbe.status -eq 401 -or $modeProbe.status -eq 403) {
        Write-Host "Hint: /api/ops/test/mode returned HTTP $($modeProbe.status). Auth may be enabled for this endpoint."
        if ($resolvedModeApiKey) {
          Write-Host "Hint: Key provided but still unauthorized/forbidden; verify key role/company scope."
        } else {
          Write-Host "Hint: Set TEST_API_KEY_ADMIN or TEST_API_KEY_OPERATOR (or API_KEY) for harness to access /api/ops/test/mode when REQUIRE_AUTH=1."
        }
        Write-Host "Hint: Start the test-safe server: .\scripts\run-test-server.ps1 (or disable REQUIRE_AUTH for test runs)."
      } elseif ($modeProbe.status -eq 404 -or $probeBodyText.Contains('not_found') -or $probeBodyText.Contains('not found')) {
        Write-Host "Hint: It looks like you are running a normal server (ALLOW_TEST_ENDPOINTS not enabled). Start the test-safe server: .\scripts\run-test-server.ps1"
      } elseif ($null -eq $modeProbe.status) {
        Write-Host "Hint: If you started the server manually with 'npm start', stop it and run: .\scripts\run-test-server.ps1"
      }
      Fail-Step 'server_mode' 'Failed to fetch /api/ops/test/mode after retries. Is the test server running with ALLOW_TEST_ENDPOINTS=true?'
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
  if ($script:HadUseIdentityMappings) {
    $env:USE_IDENTITY_MAPPINGS = $script:UseIdentityMappingsPrev
  } else {
    Remove-Item Env:USE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
  }
  if ($script:HadRequireIdentityMappings) {
    $env:REQUIRE_IDENTITY_MAPPINGS = $script:RequireIdentityMappingsPrev
  } else {
    Remove-Item Env:REQUIRE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
  }
  if ($script:HadUseEmployeesRegistry) {
    $env:USE_EMPLOYEES_REGISTRY = $script:UseEmployeesRegistryPrev
  } else {
    Remove-Item Env:USE_EMPLOYEES_REGISTRY -ErrorAction SilentlyContinue
  }
  if ($script:HadUseEmployeeAssignments) {
    $env:USE_EMPLOYEE_ASSIGNMENTS = $script:UseEmployeeAssignmentsPrev
  } else {
    Remove-Item Env:USE_EMPLOYEE_ASSIGNMENTS -ErrorAction SilentlyContinue
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
  if ($script:HadCiRunId) {
    $env:CI_RUN_ID = $script:CiRunIdPrev
  } else {
    Remove-Item Env:CI_RUN_ID -ErrorAction SilentlyContinue
  }
  if ($script:HadSeedProfile) {
    $env:SEED_PROFILE = $script:SeedProfilePrev
  } else {
    Remove-Item Env:SEED_PROFILE -ErrorAction SilentlyContinue
  }
  if ($script:StartedServer -and $script:ServerProcess) {
    try {
      Stop-Process -Id $script:ServerProcess.Id -Force
    } catch {
    }
  }
}
