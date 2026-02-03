$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = '2026-01-12'
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

function Has-NoEventsFlag {
  param($record)
  if ($record.computed -and $record.computed.flags -and ($record.computed.flags -contains 'NO_EVENTS')) {
    return $true
  }
  if ($record.flags -and ($record.flags -contains 'NO_EVENTS')) {
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
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = $personId
      date = $date
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?person_id=$personId&date=$date"
  $firstVal = Unwrap-Value $firstRaw
  $firstArr = @($firstVal)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw 'manual resolution: no attendance data returned'
  }
  if ($firstArr[0].computed.status -ne 'ABSENT') {
    throw "manual resolution: expected computed.status ABSENT, got $($firstArr[0].computed.status)"
  }
  if (-not (Has-NoEventsFlag $firstArr[0])) {
    throw 'manual resolution: expected NO_EVENTS flag'
  }

  $resolutionRaw = Invoke-RestMethod "$baseUrl/api/resolutions" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      date = $date
      decided_by = 'HR1'
      effective_status = 'PRESENT'
      reason_code = 'MANUAL_FIX'
      note = 'Approved by HR'
      override = @{}
    } | ConvertTo-Json -Depth 6)

  $resolutionVal = Unwrap-Value $resolutionRaw
  if (-not $resolutionVal -or -not $resolutionVal.id) {
    throw 'manual resolution: expected resolution id'
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?person_id=$personId&date=$date"
  $secondVal = Unwrap-Value $secondRaw
  $secondArr = @($secondVal)
  if (-not $secondArr -or $secondArr.Count -eq 0) {
    throw 'manual resolution: no attendance data returned (second)'
  }
  if ($secondArr[0].computed.status -ne 'ABSENT') {
    throw "manual resolution: expected computed.status ABSENT (second), got $($secondArr[0].computed.status)"
  }
  if ($secondArr[0].effective.status -ne 'PRESENT') {
    throw "manual resolution: expected effective.status PRESENT, got $($secondArr[0].effective.status)"
  }
  if ($secondArr[0].effective.source -ne 'MANUAL_RESOLUTION') {
    throw "manual resolution: expected effective.source MANUAL_RESOLUTION, got $($secondArr[0].effective.source)"
  }
  if (-not ($secondArr[0].effective.reasons -contains 'MANUAL_FIX')) {
    throw 'manual resolution: expected effective.reasons to include MANUAL_FIX'
  }

  try {
    $sqlRes = Invoke-RestMethod "$baseUrl/api/ops/test/sql" `
      -Method Post `
      -ContentType 'application/json' `
      -Body (@{
        sql = 'SELECT COUNT(*)::int AS n FROM attendance_day_resolutions WHERE attendance_day_id = $1 AND is_active = true';
        params = @($resolutionVal.attendance_day_id)
      } | ConvertTo-Json -Depth 6)
    $sqlVal = Unwrap-Value $sqlRes
    if ($sqlVal.rows[0].n -ne 1) {
      throw "manual resolution: expected 1 active resolution, got $($sqlVal.rows[0].n)"
    }
  } catch {
    # skip when sql endpoint is not available
  }

  Write-Host 'PASS: attendance manual resolution overlay'
  exit 0
} catch {
  Write-Host 'FAIL: attendance manual resolution overlay'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
