$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { 'p1' }

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

function Assert-ComputedParity {
  param(
    [string]$label,
    $attendance,
    $simDay,
    $simRange
  )

  if ($attendance.computed.metrics.late_minutes -ne $simDay.computed.metrics.late_minutes) {
    throw "${label}: attendance vs simulate/day late_minutes mismatch"
  }
  if ($attendance.computed.metrics.late_minutes -ne $simRange.computed.metrics.late_minutes) {
    throw "${label}: attendance vs simulate/range late_minutes mismatch"
  }

  if ($attendance.computed.status -ne $simDay.computed.status -or
    $attendance.computed.status -ne $simRange.computed.status) {
    throw "${label}: computed.status mismatch across surfaces"
  }

  if ($attendance.computed.reason_code -ne $simDay.computed.reason_code -or
    $attendance.computed.reason_code -ne $simRange.computed.reason_code) {
    throw "${label}: computed.reason_code mismatch across surfaces"
  }

  $flagsA = @($attendance.computed.flags | Sort-Object)
  $flagsD = @($simDay.computed.flags | Sort-Object)
  $flagsR = @($simRange.computed.flags | Sort-Object)
  if (($flagsA -join ',') -ne ($flagsD -join ',') -or ($flagsA -join ',') -ne ($flagsR -join ',')) {
    throw "${label}: computed.flags mismatch across surfaces"
  }
}

function Invoke-SimDay {
  param(
    [string]$date
  )
  $raw = Invoke-RestMethod "$baseUrl/api/simulate/day" `
    -Method Post `
    -Headers $script:operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      person_id = $personId
      date = $date
    } | ConvertTo-Json -Depth 6)
  return @(Unwrap-Value $raw)[0]
}

function Invoke-SimRange {
  param(
    [string]$date
  )
  $raw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -Headers $script:operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      person_id = $personId
      start_date = $date
      end_date = $date
    } | ConvertTo-Json -Depth 6)
  return @(Unwrap-Value $raw)[0]
}

function Invoke-Attendance {
  param(
    [string]$date
  )
  $raw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId" -Headers $script:operatorHeaders
  return @(Unwrap-Value $raw)[0]
}

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: attendance simulation explainability invariants (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}
$script:operatorHeaders = $operatorHeaders
$opsHeaders = if ($adminHeaders.Count -gt 0) { @{} + $adminHeaders } else { @{} + $operatorHeaders }

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } catch {
    Write-Host 'SKIP: attendance simulation explainability invariants (test endpoints unavailable)'
    exit 0
  }

  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance simulation explainability invariants (test endpoints disabled)'
    exit 0
  }

  # Case 1: late (+1 above threshold)
  $dateLate = '2026-01-20'
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $true
      day_start_time = '04:00'
      person_id = $personId
      date = $dateLate
      events = @(
        @{ event_time_utc = "$dateLate`T08:06:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$dateLate`T17:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 8) | Out-Null

  $attLateFirst = Invoke-Attendance -date $dateLate
  $attLateSecond = Invoke-Attendance -date $dateLate
  $simDayLate = Invoke-SimDay -date $dateLate
  $simRangeLate = Invoke-SimRange -date $dateLate

  Assert-ComputedParity -label 'late +1 boundary' -attendance $attLateSecond -simDay $simDayLate -simRange $simRangeLate

  if ($attLateFirst.computed.reason_code -ne $attLateSecond.computed.reason_code) {
    throw 'late +1 boundary: attendance cache recompute changed computed.reason_code unexpectedly'
  }
  if ((@($attLateFirst.computed.flags | Sort-Object) -join ',') -ne (@($attLateSecond.computed.flags | Sort-Object) -join ',')) {
    throw 'late +1 boundary: attendance cache recompute changed computed.flags unexpectedly'
  }

  # Case 2: exact threshold
  $dateThreshold = '2026-01-21'
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $true
      day_start_time = '04:00'
      person_id = $personId
      date = $dateThreshold
      events = @(
        @{ event_time_utc = "$dateThreshold`T06:05:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$dateThreshold`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 8) | Out-Null

  $attThreshold = Invoke-Attendance -date $dateThreshold
  $simDayThreshold = Invoke-SimDay -date $dateThreshold
  $simRangeThreshold = Invoke-SimRange -date $dateThreshold
  Assert-ComputedParity -label 'exact threshold' -attendance $attThreshold -simDay $simDayThreshold -simRange $simRangeThreshold
  if (Has-Flag $attThreshold 'LATE') {
    throw 'exact threshold: expected no LATE flag'
  }

  # Case 3: first OUT invalid
  $dateInvalid = '2026-01-22'
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $true
      day_start_time = '04:00'
      person_id = $personId
      date = $dateInvalid
      events = @(
        @{ event_time_utc = "$dateInvalid`T08:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$dateInvalid`T17:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 8) | Out-Null

  $attInvalid = Invoke-Attendance -date $dateInvalid
  $simDayInvalid = Invoke-SimDay -date $dateInvalid
  $simRangeInvalid = Invoke-SimRange -date $dateInvalid
  Assert-ComputedParity -label 'first OUT invalid' -attendance $attInvalid -simDay $simDayInvalid -simRange $simRangeInvalid

  # Case 4: non-working projection difference boundary
  $dateNonWork = '2026-01-25'
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $true
      day_start_time = '04:00'
      person_id = $personId
      date = $dateNonWork
      events = @(
        @{ event_time_utc = "$dateNonWork`T08:10:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$dateNonWork`T17:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 8) | Out-Null
  Invoke-RestMethod "$baseUrl/api/ops/test/seed-nonworking" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{ company_id = $companyId; date = $dateNonWork } | ConvertTo-Json) | Out-Null

  $attNonWork = Invoke-Attendance -date $dateNonWork
  $simDayNonWork = Invoke-SimDay -date $dateNonWork
  $simRangeNonWork = Invoke-SimRange -date $dateNonWork

  if ($simDayNonWork.status -ne 'NON_WORKING_DAY' -or $simRangeNonWork.status -ne 'NON_WORKING_DAY') {
    throw 'non-working projection: simulate/day and simulate/range should project NON_WORKING_DAY top-level'
  }
  if ($attNonWork.effective.status -ne 'NON_WORKING_DAY') {
    throw 'non-working projection: attendance effective.status should be NON_WORKING_DAY'
  }

  # Computed truth still aligns.
  if ($attNonWork.computed.status -ne $simDayNonWork.computed.status -or
    $attNonWork.computed.status -ne $simRangeNonWork.computed.status) {
    throw 'non-working projection: computed.status should still align across trusted surfaces'
  }

  Write-Host 'PASS: attendance simulation explainability invariants'
  exit 0
} catch {
  Write-Host 'FAIL: attendance simulation explainability invariants'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
