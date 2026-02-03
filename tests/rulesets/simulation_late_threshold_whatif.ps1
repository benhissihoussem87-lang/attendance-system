$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = '2026-01-16'
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

function Has-Flag {
  param($record, $flag)
  if ($record.computed -and $record.computed.flags -and ($record.computed.flags -contains $flag)) {
    return $true
  }
  if ($record.flags -and ($record.flags -contains $flag)) {
    return $true
  }
  return $false
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
        @{ event_time_utc = "$date`T08:10:00.000Z"; direction = 'IN'; device_uid = $deviceUid },
        @{ event_time_utc = "$date`T17:00:00.000Z"; direction = 'OUT'; device_uid = $deviceUid }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $seedA = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-late-threshold-5'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '17:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 5; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetA = $seedA.rule_set_id
  if (-not $ruleSetA) {
    throw 'seed-ruleset A did not return rule_set_id'
  }

  $seedB = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-late-threshold-15'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '17:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 15; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetB = $seedB.rule_set_id
  if (-not $ruleSetB) {
    throw 'seed-ruleset B did not return rule_set_id'
  }

  $preCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($preCount.count -ne 0) {
    throw "expected count=0 before simulation, got $($preCount.count)"
  }

  $simARaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      start_date = $date
      end_date = $date
      rule_set_id = $ruleSetA
    } | ConvertTo-Json -Depth 6)

  $simA = Unwrap-Value $simARaw
  $simAArr = @($simA)
  if ($simAArr.Count -ne 1) {
    throw "expected 1 simulation result for A, got $($simAArr.Count)"
  }
  $recA = $simAArr[0]
  if ($recA.computed.metrics.late_minutes -le 0) {
    throw "expected late_minutes > 0 for A, got $($recA.computed.metrics.late_minutes)"
  }

  $simBRaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      start_date = $date
      end_date = $date
      rule_set_id = $ruleSetB
    } | ConvertTo-Json -Depth 6)

  $simB = Unwrap-Value $simBRaw
  $simBArr = @($simB)
  if ($simBArr.Count -ne 1) {
    throw "expected 1 simulation result for B, got $($simBArr.Count)"
  }
  $recB = $simBArr[0]
  if ($recB.computed.metrics.late_minutes -ne 0) {
    throw "expected late_minutes = 0 for B, got $($recB.computed.metrics.late_minutes)"
  }
  if ((Has-Flag $recA 'LATE') -and (Has-Flag $recB 'LATE')) {
    throw 'expected LATE flag to be cleared for B when present for A'
  }

  $postCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($postCount.count -ne 0) {
    throw "expected count=0 after simulation, got $($postCount.count)"
  }

  Write-Host 'PASS: simulate late threshold what-if'
  exit 0
} catch {
  Write-Host 'FAIL: simulate late threshold what-if'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
