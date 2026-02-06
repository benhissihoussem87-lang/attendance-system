$ErrorActionPreference = 'Stop'

$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { [guid]::NewGuid().ToString('N') }

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$adminKey = if ($env:AUTH_ADMIN_KEY) {
  $env:AUTH_ADMIN_KEY
} elseif ($env:DEFAULT_API_KEY) {
  $env:DEFAULT_API_KEY
} else {
  $null
}

if (-not $adminKey) {
  Write-Host 'FAIL: AUTH_ADMIN_KEY or DEFAULT_API_KEY missing'
  exit 1
}

function Get-Status([string]$uri, [hashtable]$headers = @{}, [string]$method = 'GET', [string]$body = $null) {
  try {
    if ($body) {
      $res = Invoke-WebRequest -Uri $uri -Method $method -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 10
    } else {
      $res = Invoke-WebRequest -Uri $uri -Method $method -Headers $headers -TimeoutSec 10
    }
    return $res.StatusCode
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      return $_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

$endpoint = "$baseUrl/api/identity-mappings?limit=1&run_id=$runId"

$statusNoKey = Get-Status $endpoint @{}
if ($statusNoKey -ne 401) {
  Write-Host ("FAIL: expected 401 without key, got {0}" -f $statusNoKey)
  exit 1
}

$statusWithKey = Get-Status $endpoint @{ 'X-API-Key' = $adminKey }
if ($statusWithKey -ne 200) {
  Write-Host ("FAIL: expected 200 with key, got {0}" -f $statusWithKey)
  exit 1
}

Write-Host 'PASS: auth required'
exit 0
