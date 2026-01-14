$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-11' }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { 'p1' }

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
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $preCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($preCount.count -ne 0) {
    throw "expected count=0 before simulation, got $($preCount.count)"
  }

  $simRaw = Invoke-RestMethod "$baseUrl/api/simulate/day" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      date = $date
    } | ConvertTo-Json -Depth 6)

  $sim = Unwrap-Value $simRaw
  $simArr = @($sim)
  if ($simArr[0].source -ne 'simulation') {
    throw 'expected source=simulation'
  }
  if ($simArr[0].attendance_day_id) {
    throw 'expected attendance_day_id to be null for simulation'
  }

  $postCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($postCount.count -ne 0) {
    throw "expected count=0 after simulation, got $($postCount.count)"
  }

  $attendanceRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId"
  $attendance = Unwrap-Value $attendanceRaw
  $attendanceArr = @($attendance)
  if (-not $attendanceArr[0].status) {
    throw 'expected status in attendance response'
  }
  if (-not $attendanceArr[0].computed) {
    throw 'expected computed in attendance response'
  }

  $finalCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($finalCount.count -ne 1) {
    throw "expected count=1 after attendance, got $($finalCount.count)"
  }

  Write-Host 'PASS: simulate no persist'
  exit 0
} catch {
  Write-Host 'FAIL: simulate no persist'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}

