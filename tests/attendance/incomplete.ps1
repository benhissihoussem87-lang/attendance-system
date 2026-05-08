$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-09' }

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

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: attendance incomplete (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}
$opsHeaders = if ($adminHeaders.Count -gt 0) { @{} + $adminHeaders } else { @{} + $operatorHeaders }

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
      Write-Host 'SKIP: attendance incomplete (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance incomplete (test endpoints disabled)'
    exit 0
  }

  # CASE 1: IN only
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $inOnlyRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1" -Headers $operatorHeaders
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
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $outOnlyRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1" -Headers $operatorHeaders
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
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
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

  $repeatRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1" -Headers $operatorHeaders
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
