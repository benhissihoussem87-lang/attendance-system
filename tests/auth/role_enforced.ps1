$ErrorActionPreference = 'Stop'

$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { [guid]::NewGuid().ToString('N') }

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$viewerKey = if ($env:AUTH_VIEWER_KEY) {
  $env:AUTH_VIEWER_KEY
} elseif ($env:DEFAULT_API_KEY_VIEWER) {
  $env:DEFAULT_API_KEY_VIEWER
} else {
  $null
}

if (-not $viewerKey) {
  Write-Host 'FAIL: AUTH_VIEWER_KEY or DEFAULT_API_KEY_VIEWER missing'
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

$payload = @{
  provider = ("test-" + $runId)
  identifier_type = 'card'
  identifier_value = ("12345-" + $runId)
  person_id = ("person_" + $runId)
} | ConvertTo-Json

$endpoint = "$baseUrl/api/identity-mappings"
$status = Get-Status $endpoint @{ 'X-API-Key' = $viewerKey } 'PUT' $payload

if ($status -ne 403) {
  Write-Host ("FAIL: expected 403 for insufficient role, got {0}" -f $status)
  exit 1
}

Write-Host 'PASS: role enforced'
exit 0
