$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$date = "2026-01-06"

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
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: cache invalidation anchored (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}
$opsHeaders = if ($adminHeaders.Count -gt 0) { @{} + $adminHeaders } else { @{} + $operatorHeaders }

# Require flags ON for this regression test
if ($env:USE_DERIVED_WORK_DATE -ne "true") { throw "USE_DERIVED_WORK_DATE must be true for this test" }
if ($env:USE_COMPANY_CONFIG_DB -ne "true") { throw "USE_COMPANY_CONFIG_DB must be true for this test" }

$mode = $null
try {
  $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
} catch {
  $status = $null
  $text = ''
  try { $status = [int]$_.Exception.Response.StatusCode } catch {}
  if (-not $text) {
    try {
      if ($_.Exception.Response -and $_.Exception.Response.Content) {
        $text = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {}
  }
  if (-not $text) {
    try {
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    } catch {}
  }
  $textLower = if ($text) { $text.ToString().Trim().ToLower() } else { '' }
  $errorValue = ''
  if ($text) {
    try {
      $json = $text | ConvertFrom-Json -ErrorAction Stop
      if ($json -and $json.details -and $json.details.error) {
        $errorValue = $json.details.error.ToString().Trim().ToLower()
      } elseif ($json -and $json.error) {
        $errorValue = $json.error.ToString().Trim().ToLower()
      }
    } catch {}
  }
  if ($status -eq 404 -or $errorValue -eq 'not_found' -or $textLower.Contains('allow_test_endpoints')) {
    Write-Host 'SKIP: cache invalidation anchored (test endpoints disabled)'
    exit 0
  }
  throw
}
if (-not $mode -or -not $mode.allow_test_endpoints) {
  Write-Host 'SKIP: cache invalidation anchored (test endpoints disabled)'
  exit 0
}

# reset day with anchored boundary
Invoke-RestMethod "$baseUrl/api/ops/test/reset" -Method Post -Headers $opsHeaders -ContentType "application/json" -Body (@{
  company_id="DEFAULT"
  company_timezone="Africa/Tunis"
  night_shift_enabled=$true
  day_start_time="04:00"
  person_id="p1"
  date=$date
  events=@()
} | ConvertTo-Json -Depth 6) | Out-Null

# prime cache
Invoke-RestMethod "$baseUrl/api/attendance?date=$date" -Headers $operatorHeaders | Out-Null
$rCache = Invoke-RestMethod "$baseUrl/api/attendance?date=$date" -Headers $operatorHeaders
if ($rCache.source -ne "db") { throw "Expected cache hit from db, got: $($rCache.source)" }

# insert event with UTC date next day but anchored previous work_date
Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -Headers $operatorHeaders -ContentType "application/json" -Body (@{
  person_id="p1"
  event_time_utc="2026-01-07T02:00:00.000Z"
  direction="IN"
  device_uid = 'TEST-DEVICE-1'
  vendor=$null
  raw_payload=@{}
} | ConvertTo-Json -Depth 6) | Out-Null

$rAfter = Invoke-RestMethod "$baseUrl/api/attendance?date=$date" -Headers $operatorHeaders

# Regression assertion: must not remain a forced stale cache hit after inserting evidence for that work_date.
if ($rAfter.source -eq "db" -and $rAfter.cache_valid -eq $true -and ($rAfter.cache_reason -like "*forced_cache_hit*")) {
  throw "Regression: stale cache was not invalidated under anchored boundary"
}

"PASS: cache invalidation anchored"
