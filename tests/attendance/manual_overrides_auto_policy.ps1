$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-14' }
$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1_manual_auto_${safeRunId}"

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    throw 'manual overrides auto policy: requires ALLOW_TEST_ENDPOINTS=true'
  }

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
      affects_attendance = $true
    } | ConvertTo-Json -Depth 5) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&company_id=DEFAULT"
  $firstVal = Unwrap-Value $firstRaw
  $firstArr = @($firstVal)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw 'manual overrides auto policy: no attendance data returned'
  }
  $first = $firstArr[0]
  if (-not $first.effective -or $first.effective.status -ne 'ON_LEAVE') {
    throw "manual overrides auto policy: expected effective.status ON_LEAVE, got $($first.effective.status)"
  }
  if (-not $first.effective.source -or $first.effective.source -ne 'AUTO_POLICY') {
    throw "manual overrides auto policy: expected effective.source AUTO_POLICY, got $($first.effective.source)"
  }

  $attendanceDayId = $first.attendance_day_id
  if (-not $attendanceDayId) {
    throw 'manual overrides auto policy: attendance_day_id is missing'
  }

  $resolution = Invoke-RestMethod "$baseUrl/api/attendance/$attendanceDayId/resolutions" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      decided_by = 'HR1'
      effective_status = 'EXCUSED'
      reason_code = 'OVERRIDE_AUTO_POLICY'
    } | ConvertTo-Json -Depth 6)
  if (-not $resolution -or -not $resolution.id) {
    throw 'manual overrides auto policy: expected resolution id'
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&company_id=DEFAULT"
  $secondVal = Unwrap-Value $secondRaw
  $secondArr = @($secondVal)
  if (-not $secondArr -or $secondArr.Count -eq 0) {
    throw 'manual overrides auto policy: no attendance data returned after resolution'
  }
  $second = $secondArr[0]
  if (-not $second.effective -or $second.effective.status -ne 'EXCUSED') {
    throw "manual overrides auto policy: expected effective.status EXCUSED, got $($second.effective.status)"
  }
  if ($second.effective.source -ne 'MANUAL_RESOLUTION') {
    throw "manual overrides auto policy: expected effective.source MANUAL_RESOLUTION, got $($second.effective.source)"
  }
  if (-not $second.computed -or -not $second.computed.status) {
    throw 'manual overrides auto policy: expected computed status to remain present'
  }

  Write-Host 'PASS: attendance manual overrides auto policy'
  exit 0
} catch {
  Write-Host 'FAIL: attendance manual overrides auto policy'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
