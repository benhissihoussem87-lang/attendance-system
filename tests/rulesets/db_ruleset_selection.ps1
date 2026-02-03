$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-10' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { "p1-$runId" }
$deviceUid = "TEST-DEVICE-1-$runId"

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

try {
  $seed = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-db-ruleset'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '16:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 0; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetId = $seed.rule_set_id
  if (-not $ruleSetId) {
    throw 'seed-ruleset did not return rule_set_id'
  }

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
    } | ConvertTo-Json -Depth 6) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&rule_set_id=$ruleSetId"
  $first = Unwrap-Value $firstRaw
  $firstArr = @($first)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw 'no attendance data returned'
  }
  if ($firstArr[0].computed.rule_set_id -ne $ruleSetId) {
    throw "expected computed.rule_set_id=$ruleSetId"
  }
  if ($firstArr[0].computed.audit.computation_context.rule_set_selection.source -ne 'db') {
    throw 'expected rule_set_selection.source=db'
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&rule_set_id=$ruleSetId"
  $second = Unwrap-Value $secondRaw
  $secondArr = @($second)
  if ($secondArr[0].source -ne 'db') {
    throw 'expected cache source=db on second call'
  }
  if ($secondArr[0].computed.rule_set_id -ne $ruleSetId) {
    throw "expected computed.rule_set_id=$ruleSetId on cache"
  }

  Write-Host 'PASS: db ruleset selection'
  exit 0
} catch {
  Write-Host 'FAIL: db ruleset selection'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}

