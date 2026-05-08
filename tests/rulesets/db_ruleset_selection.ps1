$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-10' }
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

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: db ruleset selection (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: db ruleset selection (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: db ruleset selection (test endpoints disabled)'
    exit 0
  }

  $seed = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-db-ruleset'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '16:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 0; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetId = $seed.rule_set_id
  if (-not $ruleSetId) {
    throw 'seed-ruleset did not return rule_set_id'
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
        @{ event_time_utc = "$date`T06:00:00.000Z"; direction = 'IN'; device_uid = 'TEST-DEVICE-1' },
        @{ event_time_utc = "$date`T16:00:00.000Z"; direction = 'OUT'; device_uid = 'TEST-DEVICE-1' }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $firstRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&rule_set_id=$ruleSetId" -Headers $operatorHeaders
  $first = Unwrap-Value $firstRaw
  $firstArr = @($first)
  if (-not $firstArr -or $firstArr.Count -eq 0) {
    throw 'no attendance data returned'
  }
  if ($firstArr[0].computed.rule_set_id -ne $ruleSetId) {
    throw "expected computed.rule_set_id=$ruleSetId"
  }
  if ($firstArr[0].computed.audit.computation_context.rule_set_selection.source -ne 'db') {
    throw 'expected rule_set_selection.source=db'
  }

  $secondRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&rule_set_id=$ruleSetId" -Headers $operatorHeaders
  $second = Unwrap-Value $secondRaw
  $secondArr = @($second)
  if ($secondArr[0].source -ne 'db') {
    throw 'expected cache source=db on second call'
  }
  if ($secondArr[0].computed.rule_set_id -ne $ruleSetId) {
    throw "expected computed.rule_set_id=$ruleSetId on cache"
  }

  Write-Host 'PASS: db ruleset selection'
  exit 0
} catch {
  Write-Host 'FAIL: db ruleset selection'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
