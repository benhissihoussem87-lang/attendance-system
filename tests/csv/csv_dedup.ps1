$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$person = "ps_" + [guid]::NewGuid().ToString("N")
$csv = @"
person_id,event_time,direction
$person,2026-01-07T08:00:00Z,IN
$person,2026-01-07T17:00:00Z,OUT
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
    Write-Host 'SKIP: csv_dedup (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
  $first = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'text/plain' `
    -Body $csv
  if (($first.inserted_rows + $first.failed_rows) -ne $first.total_rows) {
    Write-Host "FAIL: csv_dedup first insert"
    exit 1
  }

  $second = Invoke-RestMethod "${baseUrl}/api/device-events/import/commit?company_id=${encodedCompanyId}" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'text/plain' `
    -Body $csv
  if ($second.inserted_rows -ne 0 -or ($second.skipped_rows + $second.failed_rows) -ne $second.total_rows) {
    Write-Host "FAIL: csv_dedup second insert"
    exit 1
  }

  Write-Host "PASS: csv_dedup"
  exit 0
} catch {
  Write-Host "FAIL: csv_dedup"
  exit 1
}
