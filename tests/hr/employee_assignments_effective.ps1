$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$personId = 'ea_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
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
  $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
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
    -ContentType 'application/json' `
    -Body (@{
      name = 'assign-rule-B'
      version = 1
      rules = $rules
    } | ConvertTo-Json -Depth 6)
  $ruleB = $seedB.rule_set_id
  if (-not $ruleB) { throw 'seed-ruleset did not return rule_set_id for rule B' }

  Invoke-RestMethod "$baseUrl/api/employees-registry/${personId}?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      default_rule_set_id = $ruleA
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $employee = Invoke-RestMethod "$baseUrl/api/employees-registry/${personId}?company_id=DEFAULT"
  if ($employee.default_rule_set_id -ne $ruleA) {
    throw 'expected employee default_rule_set_id to match rule A'
  }

  Invoke-RestMethod "$baseUrl/api/employee-assignments?company_id=DEFAULT" `
    -Method Put `
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
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
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

  $withinRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateWithin&person_id=$personId&company_id=DEFAULT"
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
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
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

  $beforeRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$dateBefore&person_id=$personId&company_id=DEFAULT"
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
