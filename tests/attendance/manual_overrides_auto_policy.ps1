$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-14' }
$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1_manual_auto_${safeRunId}"

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
    Write-Host 'SKIP: attendance manual overrides auto policy (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: attendance manual overrides auto policy (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance manual overrides auto policy (test endpoints disabled)'
    exit 0
  }

  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = $personId
      date = $date
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  Invoke-RestMethod "$baseUrl/api/ops/test/seed-leave" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      person_id = $personId
      company_id = $companyId
      date = $date
      affects_attendance = $true
    } | ConvertTo-Json -Depth 5) | Out-Null

  $firstRaw = Invoke-RestMethod "${baseUrl}/api/attendance?date=$date&person_id=$personId&company_id=${encodedCompanyId}" -Headers $operatorHeaders
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
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      decided_by = 'HR1'
      effective_status = 'EXCUSED'
      reason_code = 'OVERRIDE_AUTO_POLICY'
    } | ConvertTo-Json -Depth 6)
  if (-not $resolution -or -not $resolution.id) {
    throw 'manual overrides auto policy: expected resolution id'
  }

  $secondRaw = Invoke-RestMethod "${baseUrl}/api/attendance?date=$date&person_id=$personId&company_id=${encodedCompanyId}" -Headers $operatorHeaders
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
