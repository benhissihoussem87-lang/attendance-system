$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { ([guid]::NewGuid().ToString('N')).Substring(0, 8) }

function Get-Status([string]$uri, [hashtable]$headers = @{}, [string]$method = 'GET', [string]$body = $null) {
  try {
    if ($body) {
      $res = Invoke-WebRequest -Uri $uri -Method $method -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 10
    } else {
      $res = Invoke-WebRequest -Uri $uri -Method $method -Headers $headers -TimeoutSec 10
    }
    return [int]$res.StatusCode
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

try {
  $probeStatus = Get-Status "$baseUrl/api/identity-mappings?company_id=DEFAULT&limit=1&run_id=$runId"
  $authEnabled = ($probeStatus -eq 401 -or $probeStatus -eq 403)
  if (-not $authEnabled) {
    Write-Host 'SKIP: tenant scope required for admin endpoints (REQUIRE_AUTH disabled)'
    exit 0
  }

  $endpoints = @(
    "$baseUrl/api/devices?company_id=DEFAULT&limit=1&run_id=$runId",
    "$baseUrl/api/employee-assignments?company_id=DEFAULT&limit=1&run_id=$runId",
    "$baseUrl/api/company-profile?company_id=DEFAULT&run_id=$runId"
  )

  foreach ($endpoint in $endpoints) {
    $status = Get-Status $endpoint @{}
    if ($status -ne 401 -and $status -ne 403) {
      throw ("expected unauthorized status (401/403) for endpoint without api key: {0}; got {1}" -f $endpoint, $status)
    }
  }

  Write-Host 'PASS: tenant scope required for admin endpoints'
  exit 0
} catch {
  Write-Host 'FAIL: tenant scope required for admin endpoints'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
