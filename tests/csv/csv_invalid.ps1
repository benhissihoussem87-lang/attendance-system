$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$csv = @"
person_id,event_time,direction
,2026-01-07 08:00:00,IN
"@

function To-Bool {
  param($value)
  if ($null -eq $value) { return $false }
  if ($value -is [bool]) { return $value }
  if ($value -is [int]) { return $value -ne 0 }
  $text = $value.ToString().Trim().ToLower()
  if ($text -in @('1', 'true', 'yes', 'y', 'on')) { return $true }
  if ($text -in @('0', 'false', 'no', 'n', 'off', '')) { return $false }
  return $false
}

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $operatorKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $operatorKey) {
    Write-Host 'SKIP: csv_invalid (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($operatorKey) {
    $operatorHeaders['x-api-key'] = $operatorKey
  } elseif ($adminKey) {
    $operatorHeaders['x-api-key'] = $adminKey
  }
}

try {
  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'text/plain' `
    -Body $csv
  if ($res.invalid_rows -le 0) {
    Write-Host "FAIL: csv_invalid"
    exit 1
  }
  Write-Host "PASS: csv_invalid"
  exit 0
} catch {
  Write-Host "FAIL: csv_invalid"
  exit 1
}
