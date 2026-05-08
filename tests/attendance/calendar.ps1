$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-07' }
$goldenPath = Join-Path $PSScriptRoot '..\golden\attendance_calendar.json'

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
    Write-Host 'SKIP: attendance calendar (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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

function Normalize-Object {
  param(
    [Parameter(ValueFromPipeline)]$obj,
    [int]$depth = 0
  )

  if ($null -eq $obj) { return $null }
  if ($obj -is [string]) { return $obj }
  if ($depth -gt 5) { return $null }

  if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
    $list = @()
    foreach ($item in $obj) {
      $list += (Normalize-Object $item ($depth + 1))
    }
    return ,$list
  }

  if ($obj.PSObject -and $obj.PSObject.Properties.Count -gt 0) {
    $ordered = [ordered]@{}
    foreach ($name in ($obj.PSObject.Properties.Name | Sort-Object)) {
      $ordered[$name] = Normalize-Object $obj.$name ($depth + 1)
    }
    return $ordered
  }

  return $obj
}

function Filter-AttendanceRecord {
  param([Parameter(ValueFromPipeline)]$record)
  if ($null -eq $record) { return $null }
  return [ordered]@{
    system_version = $record.system_version
    contract = $record.contract
    engine_contract = $record.engine_contract
    engine_version = $record.engine_version
    employee = $record.employee
    status = $record.status
    first_in = $record.first_in
    last_out = $record.last_out
    worked_minutes = $record.worked_minutes
    late_minutes = $record.late_minutes
    explanation = $record.explanation
  }
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
      Write-Host 'SKIP: attendance calendar (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance calendar (test endpoints disabled)'
    exit 0
  }

  $resetBody = @{
    company_id = $companyId
    company_timezone = 'Africa/Tunis'
    night_shift_enabled = $false
    day_start_time = '04:00'
    person_id = 'p1'
    date = $date
    events = @(
      @{ event_time_utc = '2026-01-07T06:00:00.000Z'; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
      @{ event_time_utc = '2026-01-07T16:00:00.000Z'; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
    )
  }
  if ($null -eq $resetBody.night_shift_enabled) {
    throw "night_shift_enabled must be boolean in reset body"
  }
  if (-not ($resetBody.night_shift_enabled -is [bool])) {
    throw "night_shift_enabled must be boolean in reset body"
  }

  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body ($resetBody | ConvertTo-Json -Depth 5) | Out-Null

  Invoke-RestMethod "${baseUrl}/api/attendance?date=$date&company_id=${encodedCompanyId}" -Headers $operatorHeaders | Out-Null
  $res = Invoke-RestMethod "${baseUrl}/api/attendance?date=$date&company_id=${encodedCompanyId}" -Headers $operatorHeaders
  $expectedRaw = Get-Content -Raw $goldenPath
  $expected = $expectedRaw | ConvertFrom-Json

  $actualSource = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value } else { $res }
  $expectedSource = if ($expected -and $expected.PSObject -and $expected.PSObject.Properties.Name -contains 'value') { $expected.value } else { $expected }

  # Force same shape: ARRAY
  $actualArr = @($actualSource) | ForEach-Object { Filter-AttendanceRecord $_ }
  $expectedArr = @($expectedSource) | ForEach-Object { Filter-AttendanceRecord $_ }

  $normActual = Normalize-Object $actualArr | ConvertTo-Json -Depth 10 -Compress
  $normExpected = Normalize-Object $expectedArr | ConvertTo-Json -Depth 10 -Compress

  if ($normActual -ne $normExpected) {
    $prettyActual = Normalize-Object $actualArr | ConvertTo-Json -Depth 10
    $prettyExpected = Normalize-Object $expectedArr | ConvertTo-Json -Depth 10
    Write-Host "---- ACTUAL (normalized) ----"
    Write-Host $prettyActual
    Write-Host ""
    Write-Host "---- EXPECTED (normalized) ----"
    Write-Host $prettyExpected
    Write-Host "FAIL: attendance calendar mismatch"
    exit 1
  }
  Write-Host "PASS: attendance calendar"
  exit 0
} catch {
  Write-Host "FAIL: attendance calendar"
  Write-Host "---- ERROR ----"
  Write-Host $_
  exit 1
}

