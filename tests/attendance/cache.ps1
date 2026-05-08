$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-08' }

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
    Write-Host 'SKIP: cache (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: cache (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: cache (test endpoints disabled)'
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
      person_id = 'p1'
      date = $date
      events = @(
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 5) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date" -Headers $operatorHeaders
  $firstSource = Unwrap-Value $firstRaw
  $firstArr = @($firstSource)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw "cache first: no data returned"
  }
  if ($firstArr[0].PSObject.Properties.Name -contains 'cache_valid' -and $firstArr[0].cache_valid -eq $true) {
    throw "cache first: unexpected cache hit"
  }
  if ($firstArr[0].source -eq 'policy') {
    Write-Host "SKIP: cache test (policy result: $($firstArr[0].status))"
    exit 0
  }
  if ($firstArr[0].source -ne 'engine') {
    Write-Host "---- FIRST (raw) ----"
    Write-Host ($firstRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- FIRST (array) ----"
    Write-Host ($firstArr | ConvertTo-Json -Depth 10)
    throw "cache first: expected source=engine"
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date" -Headers $operatorHeaders
  $secondSource = Unwrap-Value $secondRaw
  $secondArr = @($secondSource)
  if (-not $secondArr -or $secondArr.Count -eq 0) {
    throw "cache second: no data returned"
  }
  if ($secondArr[0].PSObject.Properties.Name -contains 'cache_valid' -and $secondArr[0].cache_valid -ne $true) {
    Write-Host "---- SECOND (raw) ----"
    Write-Host ($secondRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- SECOND (array) ----"
    Write-Host ($secondArr | ConvertTo-Json -Depth 10)
    throw "cache second: cache not valid"
  }
  if ($secondArr[0].source -ne 'db') {
    Write-Host "---- SECOND (raw) ----"
    Write-Host ($secondRaw | ConvertTo-Json -Depth 10)
    Write-Host "---- SECOND (array) ----"
    Write-Host ($secondArr | ConvertTo-Json -Depth 10)
    throw "cache second: expected source=db"
  }

  Write-Host "PASS: cache"
  exit 0
} catch {
  Write-Host "FAIL: cache"
  Write-Host "---- ERROR ----"
  Write-Host $_
  exit 1
}
