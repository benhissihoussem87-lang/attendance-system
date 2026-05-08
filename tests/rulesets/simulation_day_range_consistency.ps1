$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { 'p1' }
$date = '2026-01-17'

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

function Assert-DayRangeParity {
  param(
    [string]$label,
    [hashtable]$payload
  )

  $dayRaw = Invoke-RestMethod "$baseUrl/api/simulate/day" `
    -Method Post `
    -Headers $script:operatorHeaders `
    -ContentType 'application/json' `
    -Body ($payload | ConvertTo-Json -Depth 8)

  $day = @(Unwrap-Value $dayRaw)
  if ($day.Count -ne 1) {
    throw "${label}: expected day result count=1, got $($day.Count)"
  }
  $dayRec = $day[0]

  $rangePayload = @{} + $payload
  $rangePayload['start_date'] = $payload.date
  $rangePayload['end_date'] = $payload.date
  $rangePayload.Remove('date') | Out-Null

  $rangeRaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -Headers $script:operatorHeaders `
    -ContentType 'application/json' `
    -Body ($rangePayload | ConvertTo-Json -Depth 8)

  $range = @(Unwrap-Value $rangeRaw)
  if ($range.Count -ne 1) {
    throw "${label}: expected range result count=1, got $($range.Count)"
  }
  $rangeRec = $range[0]

  if ($dayRec.status -ne $rangeRec.status) {
    throw "${label}: status mismatch day=$($dayRec.status) range=$($rangeRec.status)"
  }
  if ($dayRec.late_minutes -ne $rangeRec.late_minutes) {
    throw "${label}: late_minutes mismatch day=$($dayRec.late_minutes) range=$($rangeRec.late_minutes)"
  }
  if ((Has-Flag $dayRec 'LATE') -ne (Has-Flag $rangeRec 'LATE')) {
    throw "${label}: LATE flag mismatch between day and range"
  }
  if ($dayRec.effective.status -ne $rangeRec.effective.status) {
    throw "${label}: effective.status mismatch day=$($dayRec.effective.status) range=$($rangeRec.effective.status)"
  }
}

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: simulation day/range consistency (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
    $status = $null
    $text = ''
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    if (-not $text) {
      try {
        if ($_.Exception.Response -and $_.Exception.Response.Content) {
          $text = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      } catch {}
    }
    if (-not $text) {
      try {
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
      } catch {}
    }
    $textLower = if ($text) { $text.ToString().Trim().ToLower() } else { '' }
    $errorValue = ''
    if ($text) {
      try {
        $json = $text | ConvertFrom-Json -ErrorAction Stop
        if ($json -and $json.details -and $json.details.error) {
          $errorValue = $json.details.error.ToString().Trim().ToLower()
        } elseif ($json -and $json.error) {
          $errorValue = $json.error.ToString().Trim().ToLower()
        }
      } catch {}
    }
    if ($status -eq 404 -or $errorValue -eq 'not_found' -or $textLower.Contains('allow_test_endpoints')) {
      Write-Host 'SKIP: simulation day/range consistency (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: simulation day/range consistency (test endpoints disabled)'
    exit 0
  }

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
      date = $date
      events = @(
        @{ event_time_utc = "$date`T08:10:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T17:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  Assert-DayRangeParity -label 'baseline parity' -payload @{
    company_id = $companyId
    person_id = $personId
    date = $date
  }

  Assert-DayRangeParity -label 'late-threshold override parity' -payload @{
    company_id = $companyId
    person_id = $personId
    date = $date
    policy_override = @{
      late_threshold_minutes = 15
    }
  }

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-nonworking" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      date = $date
    } | ConvertTo-Json -Depth 4) | Out-Null

  Assert-DayRangeParity -label 'non-working parity' -payload @{
    company_id = $companyId
    person_id = $personId
    date = $date
  }

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
      date = $date
      events = @(
        @{ event_time_utc = "$date`T08:10:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T17:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-leave" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      person_id = $personId
      date = $date
      leave_type = 'TEST_LEAVE'
      affects_attendance = $true
    } | ConvertTo-Json -Depth 6) | Out-Null

  Assert-DayRangeParity -label 'leave parity' -payload @{
    company_id = $companyId
    person_id = $personId
    date = $date
  }

  Write-Host 'PASS: simulation day/range consistency'
  exit 0
} catch {
  Write-Host 'FAIL: simulation day/range consistency'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
