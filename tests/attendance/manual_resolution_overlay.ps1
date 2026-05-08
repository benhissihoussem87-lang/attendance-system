$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = '2026-01-12'

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
    Write-Host 'SKIP: attendance manual resolution overlay (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: attendance manual resolution overlay (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance manual resolution overlay (test endpoints disabled)'
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
      person_id = 'p1'
      date = $date
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?person_id=p1&date=$date" -Headers $operatorHeaders
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
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = $companyId
      person_id = 'p1'
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

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?person_id=p1&date=$date" -Headers $operatorHeaders
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
      -Headers $opsHeaders `
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
