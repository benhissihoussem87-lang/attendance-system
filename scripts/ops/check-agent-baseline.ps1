[CmdletBinding()]
param(
  [string]$ServerHost = "127.0.0.1",
  [int]$ServerPort = 3000,
  [string]$ServerUrl = "http://127.0.0.1:3000",
  [string]$DiagnosticsHost = "127.0.0.1",
  [int]$DiagnosticsPort = 4780,
  [string]$K80Host = "192.168.22.201",
  [int]$K80Port = 4370,
  [string]$CompanyId = "DEFAULT",
  [int]$HeartbeatFreshSeconds = 90
)

$ErrorActionPreference = "Stop"

function Write-StatusLine {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Status,
    [string]$Detail = ""
  )
  if ([string]::IsNullOrWhiteSpace($Detail)) {
    Write-Output ("{0}: {1}" -f $Name, $Status)
  } else {
    Write-Output ("{0}: {1} - {2}" -f $Name, $Status, $Detail)
  }
}

function Test-TcpPort {
  param([string]$HostName, [int]$Port, [int]$TimeoutMs = 1500)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }
    $client.EndConnect($async)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Read-DotEnvValue {
  param([string]$Key)
  $path = Join-Path (Get-Location) ".env"
  if (-not (Test-Path $path)) { return $null }
  $line = Get-Content -Path $path | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Get-DbEnvValue {
  param([string]$Key, [string]$Fallback)
  $value = [Environment]::GetEnvironmentVariable($Key)
  if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  $value = Read-DotEnvValue -Key $Key
  if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  return $Fallback
}

function Invoke-HeartbeatProbe {
  $psql = Get-Command psql -ErrorAction SilentlyContinue
  if (-not $psql) {
    Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail "psql not found"
    return
  }

  $pgPassCandidates = @(
    [Environment]::GetEnvironmentVariable("PGPASSFILE"),
    (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "postgresql\pgpass.conf"),
    (Join-Path $HOME ".pgpass")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $hasPasswordMaterial = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("PGPASSWORD"))
  if (-not $hasPasswordMaterial) {
    foreach ($candidate in $pgPassCandidates) {
      if (Test-Path $candidate) {
        $hasPasswordMaterial = $true
        break
      }
    }
  }
  if (-not $hasPasswordMaterial) {
    Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail "database credentials unavailable; set PGPASSWORD or pgpass to enable DB heartbeat check"
    return
  }

  $env:PGHOST = Get-DbEnvValue -Key "PGHOST" -Fallback "localhost"
  $env:PGPORT = Get-DbEnvValue -Key "PGPORT" -Fallback "5432"
  $env:PGUSER = Get-DbEnvValue -Key "PGUSER" -Fallback "postgres"
  $env:PGDATABASE = Get-DbEnvValue -Key "PGDATABASE" -Fallback "attendance"
  $env:PGSSLMODE = if ((Get-DbEnvValue -Key "PGSSL" -Fallback "false") -eq "true") { "require" } else { "disable" }
  $env:PGCONNECT_TIMEOUT = "3"

  $query = @"
WITH latest AS (
  SELECT
    id::text AS agent_id,
    agent_name,
    status,
    last_heartbeat_at,
    EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::int AS age_seconds
  FROM public.agent_nodes
  WHERE company_id = '$CompanyId'
    AND status = 'active'
  ORDER BY last_heartbeat_at DESC NULLS LAST
  LIMIT 1
)
SELECT COALESCE(agent_id, ''), COALESCE(agent_name, ''), COALESCE(status, ''), COALESCE(last_heartbeat_at::text, ''), COALESCE(age_seconds::text, '')
FROM latest;
"@

  try {
    $result = & $psql.Source -w -t -A -F "|" -c $query 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail "psql connection failed; verify PG env, pgpass, or local trust auth"
      return
    }
    $line = ($result | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    if ($line -match '^psql:' -or $line -match 'fe_sendauth') {
      Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail "psql connection failed; verify PG env, pgpass, or local trust auth"
      return
    }
    if (-not $line) {
      Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail "no active agent row for company $CompanyId"
      return
    }
    $parts = $line -split "\|", 5
    $agentName = $parts[1]
    $lastHeartbeat = $parts[3]
    $ageRaw = $parts[4]
    $age = 999999
    [int]::TryParse($ageRaw, [ref]$age) | Out-Null
    if ($age -le $HeartbeatFreshSeconds) {
      Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_FRESH" -Detail "$agentName last_heartbeat_at=$lastHeartbeat age_seconds=$age"
    } else {
      Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_STALE" -Detail "$agentName last_heartbeat_at=$lastHeartbeat age_seconds=$age"
    }
  } catch {
    Write-StatusLine -Name "HEARTBEAT" -Status "HEARTBEAT_UNKNOWN" -Detail $_.Exception.Message
  }
}

function Get-NestedValue {
  param($Value, [string[]]$Path)
  $current = $Value
  foreach ($segment in $Path) {
    if ($null -eq $current) { return $null }
    if ($current -is [System.Collections.IDictionary]) {
      if (-not $current.Contains($segment)) { return $null }
      $current = $current[$segment]
      continue
    }
    $property = $current.PSObject.Properties[$segment]
    if (-not $property) { return $null }
    $current = $property.Value
  }
  return $current
}

function Invoke-AgentRtPolicyProbe {
  param([string]$BaseDiagnosticsUrl)
  try {
    $response = Invoke-WebRequest -Uri "$BaseDiagnosticsUrl/api/local-diagnostics" -UseBasicParsing -TimeoutSec 5
    $snapshot = $response.Content | ConvertFrom-Json
    $policyEnabled = Get-NestedValue -Value $snapshot -Path @('agent', 'k80_rt_subscriber_enabled')
    $policyDeviceUid = Get-NestedValue -Value $snapshot -Path @('agent', 'k80_rt_subscriber_device_uid')
    $policyAllowlistCount = Get-NestedValue -Value $snapshot -Path @('agent', 'k80_rt_subscriber_allowlist_count')
    if ($policyEnabled -eq $true -and -not [string]::IsNullOrWhiteSpace($policyDeviceUid)) {
      Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_ENABLED" -Detail "device_uid=$policyDeviceUid allowlist_count=$policyAllowlistCount"
      return
    }
    if ($policyEnabled -eq $false) {
      Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_DISABLED" -Detail "diagnostics reports k80_rt_subscriber_enabled=false"
      return
    }
    $agentStartedAtRaw = Get-NestedValue -Value $snapshot -Path @('agent', 'started_at')
    $agentStartedAt = $null
    if (-not [string]::IsNullOrWhiteSpace($agentStartedAtRaw)) {
      $agentStartedAt = [datetime]::Parse($agentStartedAtRaw)
    }
    $lastFailure = Get-NestedValue -Value $snapshot -Path @('commands', 'last_failure')
    $lastSuccess = Get-NestedValue -Value $snapshot -Path @('commands', 'last_success')
    $recent = Get-NestedValue -Value $snapshot -Path @('commands', 'recent')
    $rtSubscriber = Get-NestedValue -Value $snapshot -Path @('rt_subscriber')

    $candidateEntries = @()
    if ($lastFailure) { $candidateEntries += $lastFailure }
    if ($lastSuccess) { $candidateEntries += $lastSuccess }
    if ($recent -and $recent -is [System.Array]) { $candidateEntries += $recent }

    foreach ($entry in $candidateEntries) {
      $commandType = Get-NestedValue -Value $entry -Path @('command_type')
      $reasonCode = Get-NestedValue -Value $entry -Path @('reason_code')
      $ok = Get-NestedValue -Value $entry -Path @('ok')
      $details = Get-NestedValue -Value $entry -Path @('details')
      $completedAtRaw = Get-NestedValue -Value $entry -Path @('completed_at')
      if ($agentStartedAt -and -not [string]::IsNullOrWhiteSpace($completedAtRaw)) {
        try {
          $completedAt = [datetime]::Parse($completedAtRaw)
          if ($completedAt -lt $agentStartedAt) {
            continue
          }
        } catch {
          # Keep inspecting the entry if timestamp parsing fails.
        }
      }
      $runtimeMonitoringState = Get-NestedValue -Value $details -Path @('runtime_monitoring_state')
      $subscriberStarted = Get-NestedValue -Value $details -Path @('rt_subscriber_started')
      if ($commandType -eq 'START_DEVICE_MONITORING') {
        if ($reasonCode -eq 'subscriber_disabled') {
          Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_DISABLED" -Detail "last START_DEVICE_MONITORING failed with subscriber_disabled"
          return
        }
        if ($reasonCode -eq 'subscriber_device_not_allowed') {
          Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_DISABLED" -Detail "last START_DEVICE_MONITORING failed with subscriber_device_not_allowed"
          return
        }
        if ($ok -eq $true -or $runtimeMonitoringState -eq 'active' -or $subscriberStarted -eq $true) {
          Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_ENABLED" -Detail "last START_DEVICE_MONITORING reached active/subscriber state"
          return
        }
      }
    }

    $lastInitiation = Get-NestedValue -Value $rtSubscriber -Path @('last_initiation')
    $lastSession = Get-NestedValue -Value $rtSubscriber -Path @('last_session')
    if ($lastInitiation -or $lastSession) {
      $sessionReason = Get-NestedValue -Value $lastSession -Path @('reason')
      $sessionOk = Get-NestedValue -Value $lastSession -Path @('ok')
      if ($sessionOk -eq $true) {
        Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_ENABLED" -Detail "diagnostics has successful RT subscriber session evidence"
        return
      }
      Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_UNKNOWN" -Detail "diagnostics has RT subscriber evidence but no explicit startup policy flag; last_reason=$sessionReason"
      return
    }

    Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_UNKNOWN" -Detail "diagnostics does not expose startup policy directly; no monitoring attempt evidence yet"
  } catch {
    Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_UNKNOWN" -Detail $_.Exception.Message
  }
}

Write-Output "Attendance System Local Runtime Baseline"
Write-Output ("Checked at: {0}" -f (Get-Date).ToString("s"))
Write-Output ""

if (Test-TcpPort -HostName $ServerHost -Port $ServerPort) {
  Write-StatusLine -Name "SERVER" -Status "SERVER_OK" -Detail "$ServerHost`:$ServerPort listening"
} else {
  Write-StatusLine -Name "SERVER" -Status "SERVER_DOWN" -Detail "$ServerHost`:$ServerPort not reachable"
}

try {
  Invoke-WebRequest -Uri "$ServerUrl/api/auth/me" -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-StatusLine -Name "AUTH_PROBE" -Status "AUTH_PROBE_UNEXPECTED" -Detail "/api/auth/me returned success without browser session"
} catch {
  $statusCode = $null
  if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
  if ($statusCode -eq 401) {
    Write-StatusLine -Name "AUTH_PROBE" -Status "AUTH_PROBE_OK" -Detail "unauthenticated /api/auth/me returned 401"
  } else {
    Write-StatusLine -Name "AUTH_PROBE" -Status "AUTH_PROBE_UNKNOWN" -Detail $_.Exception.Message
  }
}

$agentProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'agent[\\/]index\.js'
})
if ($agentProcesses.Count -eq 1) {
  Write-StatusLine -Name "AGENT_PROCESS" -Status "AGENT_PROCESS_OK" -Detail "pid=$($agentProcesses[0].ProcessId)"
} elseif ($agentProcesses.Count -gt 1) {
  $pids = ($agentProcesses | ForEach-Object { $_.ProcessId }) -join ","
  Write-StatusLine -Name "AGENT_PROCESS" -Status "AGENT_PROCESS_MULTIPLE" -Detail "pids=$pids"
} else {
  Write-StatusLine -Name "AGENT_PROCESS" -Status "AGENT_NOT_RUNNING"
}

if (Test-TcpPort -HostName $DiagnosticsHost -Port $DiagnosticsPort) {
  $diagnosticsBaseUrl = "http://$DiagnosticsHost`:$DiagnosticsPort"
  try {
    Invoke-WebRequest -Uri "$diagnosticsBaseUrl/api/local-diagnostics/health" -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-StatusLine -Name "AGENT_DIAGNOSTICS" -Status "AGENT_DIAGNOSTICS_OK" -Detail "$DiagnosticsHost`:$DiagnosticsPort /api/local-diagnostics/health reachable"
    Invoke-AgentRtPolicyProbe -BaseDiagnosticsUrl $diagnosticsBaseUrl
  } catch {
    Write-StatusLine -Name "AGENT_DIAGNOSTICS" -Status "AGENT_DIAGNOSTICS_PORT_ONLY" -Detail $_.Exception.Message
    Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_UNKNOWN" -Detail "diagnostics API unavailable"
  }
} else {
  Write-StatusLine -Name "AGENT_DIAGNOSTICS" -Status "AGENT_DIAGNOSTICS_DOWN" -Detail "$DiagnosticsHost`:$DiagnosticsPort not reachable"
  Write-StatusLine -Name "AGENT_RT_POLICY" -Status "AGENT_RT_POLICY_UNKNOWN" -Detail "diagnostics down"
}

Invoke-HeartbeatProbe

if (Test-TcpPort -HostName $K80Host -Port $K80Port -TimeoutMs 2000) {
  Write-StatusLine -Name "K80" -Status "K80_REACHABLE" -Detail "$K80Host`:$K80Port reachable"
} else {
  Write-StatusLine -Name "K80" -Status "K80_UNREACHABLE" -Detail "$K80Host`:$K80Port not reachable"
}

Write-Output ""
Write-Output "This script is read-only: it does not start/stop processes, queue commands, run sync, or mutate the database."
