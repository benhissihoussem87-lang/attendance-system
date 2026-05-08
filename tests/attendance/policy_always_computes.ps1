$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-10' }

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
    Write-Host 'SKIP: attendance policy always computes (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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

function Next-Date {
  param([string]$dateString)
  $parsed = [datetime]::ParseExact($dateString, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
  return $parsed.AddDays(1).ToString('yyyy-MM-dd')
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
      Write-Host 'SKIP: attendance policy always computes (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance policy always computes (test endpoints disabled)'
    exit 0
  }

  $dateB = Next-Date $date
  $dateC = Next-Date $dateB
  $allowedStatuses = @('ABSENT', 'INCOMPLETE', 'PRESENT', 'INVALID')

  # CASE A: leave with affects_attendance=false does not force ON_LEAVE
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
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-leave" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      person_id = 'p1'
      company_id = $companyId
      date = $date
      affects_attendance = $false
    } | ConvertTo-Json -Depth 5) | Out-Null

  $leaveIgnoredRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1" -Headers $operatorHeaders
  $leaveIgnoredVal = Unwrap-Value $leaveIgnoredRaw
  $leaveIgnoredArr = @($leaveIgnoredVal)
  if (-not $leaveIgnoredArr -or $leaveIgnoredArr.Count -eq 0) {
    throw 'leave ignored case: no data returned'
  }
  if (-not $leaveIgnoredArr[0].computed) {
    throw 'leave ignored case: computed is missing'
  }
  if (-not ($allowedStatuses -contains $leaveIgnoredArr[0].computed.status)) {
    throw "leave ignored case: unexpected computed.status $($leaveIgnoredArr[0].computed.status)"
  }
  if ($leaveIgnoredArr[0].effective.status -eq 'ON_LEAVE') {
    throw 'leave ignored case: expected effective.status not ON_LEAVE when affects_attendance=false'
  }
  if ($leaveIgnoredArr[0].source -eq 'policy') {
    throw 'leave ignored case: source should not be policy-only'
  }

  $leaveIgnoredCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=p1&work_date=$date" -Headers $opsHeaders
  if ($leaveIgnoredCount.count -lt 1) {
    throw 'leave ignored case: expected attendance_days row'
  }

  # CASE B: leave with affects_attendance=true forces ON_LEAVE
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
      date = $dateB
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-leave" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      person_id = 'p1'
      company_id = $companyId
      date = $dateB
      affects_attendance = $true
    } | ConvertTo-Json -Depth 5) | Out-Null

  $leaveRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateB&person_id=p1" -Headers $operatorHeaders
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

  $leaveCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=p1&work_date=$dateB" -Headers $opsHeaders
  if ($leaveCount.count -lt 1) {
    throw 'leave case: expected attendance_days row'
  }

  # CASE C: NON_WORKING_DAY still computes + persists
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
      date = $dateC
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-nonworking" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      date = $dateC
    } | ConvertTo-Json -Depth 5) | Out-Null

  $nonWorkRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateC&person_id=p1" -Headers $operatorHeaders
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

  $nonWorkCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=p1&work_date=$dateC" -Headers $opsHeaders
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
