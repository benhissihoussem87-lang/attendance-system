$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-08' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1-$runId"
$deviceUid = "TEST-DEVICE-1-$runId"

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

try {
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $true
      day_start_time = '04:00'
      person_id = $personId
      date = $date
      events = @(
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = $deviceUid },
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = $deviceUid }
      )
    } | ConvertTo-Json -Depth 5) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date"
  $firstSource = Unwrap-Value $firstRaw
  $firstArr = @($firstSource)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw "cache first: no data returned"
  }
  if ($firstArr[0].PSObject.Properties.Name -contains 'cache_valid' -and $firstArr[0].cache_valid -eq $true) {
    throw "cache first: unexpected cache hit"
  }
  if ($firstArr[0].source -eq 'policy') {
    Write-Host "SKIP: cache test (policy result: $($firstArr[0].status))"
    exit 0
  }
  if ($firstArr[0].source -ne 'engine') {
    Write-Host "---- FIRST (raw) ----"
    Write-Host ($firstRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- FIRST (array) ----"
    Write-Host ($firstArr | ConvertTo-Json -Depth 10)
    throw "cache first: expected source=engine"
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date"
  $secondSource = Unwrap-Value $secondRaw
  $secondArr = @($secondSource)
  if (-not $secondArr -or $secondArr.Count -eq 0) {
    throw "cache second: no data returned"
  }
  if ($secondArr[0].PSObject.Properties.Name -contains 'cache_valid' -and $secondArr[0].cache_valid -ne $true) {
    Write-Host "---- SECOND (raw) ----"
    Write-Host ($secondRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- SECOND (array) ----"
    Write-Host ($secondArr | ConvertTo-Json -Depth 10)
    throw "cache second: cache not valid"
  }
  if ($secondArr[0].source -ne 'db') {
    Write-Host "---- SECOND (raw) ----"
    Write-Host ($secondRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- SECOND (array) ----"
    Write-Host ($secondArr | ConvertTo-Json -Depth 10)
    throw "cache second: expected source=db"
  }

  Write-Host "PASS: cache"
  exit 0
} catch {
  Write-Host "FAIL: cache"
  Write-Host "---- ERROR ----"
  Write-Host $_
  exit 1
}

