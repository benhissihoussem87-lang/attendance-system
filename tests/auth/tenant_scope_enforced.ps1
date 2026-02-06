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

function Get-Status([string]$uri, [hashtable]$headers = @{}) {
  try {
    $res = Invoke-WebRequest -Uri $uri -Method GET -Headers $headers -TimeoutSec 10
    return $res.StatusCode
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      return $_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

$endpoint = "$baseUrl/api/identity-mappings?company_id=OTHER&limit=1&run_id=$runId"
$status = Get-Status $endpoint @{ 'X-API-Key' = $adminKey }

if ($status -ne 403) {
  Write-Host ("FAIL: expected 403 for company mismatch, got {0}" -f $status)
  exit 1
}

Write-Host 'PASS: tenant scope enforced'
exit 0
