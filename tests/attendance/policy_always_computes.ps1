$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-10' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1-$runId"

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

function Next-Date {
  param([string]$dateString)
  $parsed = [datetime]::ParseExact($dateString, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
  return $parsed.AddDays(1).ToString('yyyy-MM-dd')
}

try {
  $dateB = Next-Date $date
  $allowedStatuses = @('ABSENT', 'INCOMPLETE', 'PRESENT', 'INVALID')

  # CASE A: ON_LEAVE still computes + persists
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = $personId
      date = $date
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-leave" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      person_id = $personId
      company_id = 'DEFAULT'
      date = $date
    } | ConvertTo-Json -Depth 5) | Out-Null

  $leaveRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId"
  $leaveVal = Unwrap-Value $leaveRaw
  $leaveArr = @($leaveVal)
  if (-not $leaveArr -or $leaveArr.Count -eq 0) {
    throw 'leave case: no data returned'
  }
  if (-not $leaveArr[0].computed) {
    throw 'leave case: computed is missing'
  }
  if (-not ($allowedStatuses -contains $leaveArr[0].computed.status)) {
    throw "leave case: unexpected computed.status $($leaveArr[0].computed.status)"
  }
  if ($leaveArr[0].effective.status -ne 'ON_LEAVE') {
    throw "leave case: expected effective.status ON_LEAVE, got $($leaveArr[0].effective.status)"
  }
  if ($leaveArr[0].source -eq 'policy') {
    throw 'leave case: source should not be policy-only'
  }

  $leaveCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
  if ($leaveCount.count -lt 1) {
    throw 'leave case: expected attendance_days row'
  }

  # CASE B: NON_WORKING_DAY still computes + persists
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = $personId
      date = $dateB
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-nonworking" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      date = $dateB
    } | ConvertTo-Json -Depth 5) | Out-Null

  $nonWorkRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateB&person_id=$personId"
  $nonWorkVal = Unwrap-Value $nonWorkRaw
  $nonWorkArr = @($nonWorkVal)
  if (-not $nonWorkArr -or $nonWorkArr.Count -eq 0) {
    throw 'non-working case: no data returned'
  }
  if (-not $nonWorkArr[0].computed) {
    throw 'non-working case: computed is missing'
  }
  if (-not ($allowedStatuses -contains $nonWorkArr[0].computed.status)) {
    throw "non-working case: unexpected computed.status $($nonWorkArr[0].computed.status)"
  }
  if ($nonWorkArr[0].effective.status -ne 'NON_WORKING_DAY') {
    throw "non-working case: expected effective.status NON_WORKING_DAY, got $($nonWorkArr[0].effective.status)"
  }
  if ($nonWorkArr[0].source -eq 'policy') {
    throw 'non-working case: source should not be policy-only'
  }

  $nonWorkCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$dateB"
  if ($nonWorkCount.count -lt 1) {
    throw 'non-working case: expected attendance_days row'
  }

  Write-Host 'PASS: attendance policy always computes'
  exit 0
} catch {
  Write-Host 'FAIL: attendance policy always computes'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
