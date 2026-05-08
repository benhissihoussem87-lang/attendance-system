$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_hrassign"

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
    Write-Host 'SKIP: employee assignments effective (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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

$personId = "ea_$runSuffix"
$encodedPersonId = [uri]::EscapeDataString($personId)
$dateWithin = '2026-01-15'
$dateBefore = '2026-01-05'

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
      Write-Host 'SKIP: employee assignments effective (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: employee assignments effective (test endpoints disabled)'
    exit 0
  }
  if (-not $mode.use_employee_assignments) {
    Write-Host 'FAIL: use_employee_assignments not enabled'
    exit 1
  }

  $rules = @(
    @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '16:00' },
    @{ type = 'LATE_THRESHOLD'; grace_minutes = 0; late_after_minutes = 5 },
    @{ type = 'WORK_MINUTES_COMPUTE' },
    @{ type = 'LATE_MINUTES_COMPUTE' },
    @{ type = 'STATUS_BY_LATE' },
    @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
  )

  $seedA = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      name = 'assign-rule-A'
      version = 1
      rules = $rules
    } | ConvertTo-Json -Depth 6)
  $ruleA = $seedA.rule_set_id
  if (-not $ruleA) { throw 'seed-ruleset did not return rule_set_id for rule A' }

  $seedB = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      name = 'assign-rule-B'
      version = 1
      rules = $rules
    } | ConvertTo-Json -Depth 6)
  $ruleB = $seedB.rule_set_id
  if (-not $ruleB) { throw 'seed-ruleset did not return rule_set_id for rule B' }

  Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=$([uri]::EscapeDataString($companyId))" `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      default_rule_set_id = $ruleA
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $employee = Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=$([uri]::EscapeDataString($companyId))" -Headers $operatorHeaders
  if ($employee.default_rule_set_id -ne $ruleA) {
    throw 'expected employee default_rule_set_id to match rule A'
  }

  Invoke-RestMethod "$baseUrl/api/employee-assignments?company_id=$([uri]::EscapeDataString($companyId))" `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      person_id = $personId
      rule_set_id = $ruleB
      valid_from = '2026-01-10'
      valid_to = $null
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

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
      date = $dateWithin
      events = @(
        @{ event_time_utc = "$dateWithin`T06:00:00.000Z"; direction = 'IN'; device_uid = "TEST-DEVICE-1-$personId" },
        @{ event_time_utc = "$dateWithin`T16:00:00.000Z"; direction = 'OUT'; device_uid = "TEST-DEVICE-1-$personId" }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $withinRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateWithin&person_id=$personId&company_id=$([uri]::EscapeDataString($companyId))" -Headers $operatorHeaders
  $within = Unwrap-Value $withinRaw
  $withinArr = @($within)
  if (-not $withinArr -or $withinArr.Count -eq 0) { throw 'no attendance data returned for within date' }
  $withinRecord = $withinArr[0]
  $withinAudit = $withinRecord.computed.audit.assignment_resolution
  if ($withinRecord.computed.rule_set_id -ne $ruleB -and (-not $withinAudit -or $withinAudit.matched -ne $true)) {
    Write-Host '---- WITHIN RESPONSE ----'
    Write-Host ($withinRecord | ConvertTo-Json -Depth 10)
    throw "expected assignment match for within date (rule_set_id=$ruleB or matched=true)"
  }
  if ($withinAudit) {
    if ($withinAudit.matched -ne $true) {
      Write-Host '---- WITHIN RESPONSE ----'
      Write-Host ($withinRecord | ConvertTo-Json -Depth 10)
      throw 'expected matched=true for within date'
    }
    if ($withinAudit.fallback_used -ne $false) {
      Write-Host '---- WITHIN RESPONSE ----'
      Write-Host ($withinRecord | ConvertTo-Json -Depth 10)
      throw 'expected fallback_used=false for within date'
    }
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
      date = $dateBefore
      events = @(
        @{ event_time_utc = "$dateBefore`T06:00:00.000Z"; direction = 'IN'; device_uid = "TEST-DEVICE-1-$personId" },
        @{ event_time_utc = "$dateBefore`T16:00:00.000Z"; direction = 'OUT'; device_uid = "TEST-DEVICE-1-$personId" }
      )
    } | ConvertTo-Json -Depth 6) | Out-Null

  $beforeRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateBefore&person_id=$personId&company_id=$([uri]::EscapeDataString($companyId))" -Headers $operatorHeaders
  $before = Unwrap-Value $beforeRaw
  $beforeArr = @($before)
  if (-not $beforeArr -or $beforeArr.Count -eq 0) { throw 'no attendance data returned for before date' }
  $beforeRecord = $beforeArr[0]
  if (-not $beforeRecord.computed -or -not $beforeRecord.computed.status) {
    Write-Host '---- BEFORE RESPONSE ----'
    Write-Host ($beforeRecord | ConvertTo-Json -Depth 10)
    throw 'expected computed status for before date'
  }
  $beforeAudit = $beforeRecord.computed.audit.assignment_resolution
  if ($beforeAudit) {
    if ($beforeAudit.matched -ne $false) {
      Write-Host '---- BEFORE RESPONSE ----'
      Write-Host ($beforeRecord | ConvertTo-Json -Depth 10)
      throw 'expected matched=false for before date'
    }
    if ($beforeAudit.fallback_used -ne $true) {
      Write-Host '---- BEFORE RESPONSE ----'
      Write-Host ($beforeRecord | ConvertTo-Json -Depth 10)
      throw 'expected fallback_used=true for before date'
    }
  }

  Write-Host 'PASS: employee assignments effective'
  exit 0
} catch {
  Write-Host 'FAIL: employee assignments effective'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
