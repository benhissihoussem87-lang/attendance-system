$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-09' }

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

try {
  # CASE 1: IN only
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $inOnlyRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1"
  $inOnly = Unwrap-Value $inOnlyRaw
  $inOnlyArr = @($inOnly)
  if ($inOnlyArr[0].status -ne 'INCOMPLETE') {
    throw 'expected INCOMPLETE status for IN-only'
  }
  if ($inOnlyArr[0].computed.status -ne 'INCOMPLETE') {
    throw 'expected computed INCOMPLETE for IN-only'
  }
  if (-not ($inOnlyArr[0].computed.flags -contains 'MISSING_OUT')) {
    throw 'expected MISSING_OUT flag for IN-only'
  }

  # CASE 2: OUT only (invalid sequence)
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $outOnlyRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1"
  $outOnly = Unwrap-Value $outOnlyRaw
  $outOnlyArr = @($outOnly)
  if ($outOnlyArr[0].status -ne 'INVALID') {
    throw 'expected INVALID status for OUT-only'
  }
  if ($outOnlyArr[0].computed.status -ne 'INVALID') {
    throw 'expected computed INVALID for OUT-only'
  }
  if (-not ($outOnlyArr[0].computed.flags -contains 'FIRST_EVENT_OUT')) {
    throw 'expected FIRST_EVENT_OUT flag for OUT-only'
  }

  # CASE 3: repeated direction (invalid sequence)
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T07:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $repeatRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1"
  $repeat = Unwrap-Value $repeatRaw
  $repeatArr = @($repeat)
  if ($repeatArr[0].status -ne 'INVALID') {
    throw 'expected INVALID status for repeated direction'
  }
  if ($repeatArr[0].computed.status -ne 'INVALID') {
    throw 'expected computed INVALID for repeated direction'
  }
  if (-not ($repeatArr[0].computed.flags -contains 'NON_ALTERNATING_SEQUENCE')) {
    throw 'expected NON_ALTERNATING_SEQUENCE flag for repeated direction'
  }
  if (-not ($repeatArr[0].computed.flags -contains 'MULTIPLE_SAME_DIRECTION')) {
    throw 'expected MULTIPLE_SAME_DIRECTION flag for repeated direction'
  }

  Write-Host 'PASS: attendance incomplete'
  exit 0
} catch {
  Write-Host 'FAIL: attendance incomplete'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
