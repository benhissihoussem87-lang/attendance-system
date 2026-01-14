$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$date = "2026-01-06"

# Require flags ON for this regression test
if ($env:USE_DERIVED_WORK_DATE -ne "true") { throw "USE_DERIVED_WORK_DATE must be true for this test" }
if ($env:USE_COMPANY_CONFIG_DB -ne "true") { throw "USE_COMPANY_CONFIG_DB must be true for this test" }

# reset day with anchored boundary
Invoke-RestMethod "$baseUrl/api/ops/test/reset" -Method Post -ContentType "application/json" -Body (@{
  company_id="DEFAULT"
  company_timezone="Africa/Tunis"
  night_shift_enabled=$true
  day_start_time="04:00"
  person_id="p1"
  date=$date
  events=@()
} | ConvertTo-Json -Depth 6) | Out-Null

# prime cache
Invoke-RestMethod "$baseUrl/api/attendance?date=$date" | Out-Null
$rCache = Invoke-RestMethod "$baseUrl/api/attendance?date=$date"
if ($rCache.source -ne "db") { throw "Expected cache hit from db, got: $($rCache.source)" }

# insert event with UTC date next day but anchored previous work_date
Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -ContentType "application/json" -Body (@{
  person_id="p1"
  event_time_utc="2026-01-07T02:00:00.000Z"
  direction="IN"
  device_uid = 'TEST-DEVICE-1'
  vendor=$null
  raw_payload=@{}
} | ConvertTo-Json -Depth 6) | Out-Null

$rAfter = Invoke-RestMethod "$baseUrl/api/attendance?date=$date"

# Regression assertion: must not remain a forced stale cache hit after inserting evidence for that work_date.
if ($rAfter.source -eq "db" -and $rAfter.cache_valid -eq $true -and ($rAfter.cache_reason -like "*forced_cache_hit*")) {
  throw "Regression: stale cache was not invalidated under anchored boundary"
}

"PASS: cache invalidation anchored"

