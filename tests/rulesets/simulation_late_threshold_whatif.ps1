$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = '2026-01-16'
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
    Write-Host 'SKIP: simulate late threshold what-if (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: simulate late threshold what-if (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: simulate late threshold what-if (test endpoints disabled)'
    exit 0
  }

  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
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

  $seedA = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-late-threshold-5'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '17:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 5; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetA = $seedA.rule_set_id
  if (-not $ruleSetA) {
    throw 'seed-ruleset A did not return rule_set_id'
  }

  $seedB = Invoke-RestMethod "$baseUrl/api/ops/test/seed-ruleset" `
    -Method Post `
    -Headers $opsHeaders `
    -ContentType 'application/json' `
    -Body (@{
      name = 'test-late-threshold-15'
      version = 1
      rules = @(
        @{ type = 'FIXED_SHIFT'; start = '08:00'; end = '17:00' },
        @{ type = 'LATE_THRESHOLD'; grace_minutes = 15; late_after_minutes = 5 },
        @{ type = 'WORK_MINUTES_COMPUTE' },
        @{ type = 'LATE_MINUTES_COMPUTE' },
        @{ type = 'STATUS_BY_LATE' },
        @{ type = 'STATUS_FALLBACK'; status = 'ABSENT' }
      )
    } | ConvertTo-Json -Depth 6)

  $ruleSetB = $seedB.rule_set_id
  if (-not $ruleSetB) {
    throw 'seed-ruleset B did not return rule_set_id'
  }

  $preCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date" -Headers $opsHeaders
  if ($preCount.count -ne 0) {
    throw "expected count=0 before simulation, got $($preCount.count)"
  }

  $simARaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      start_date = $date
      end_date = $date
      rule_set_id = $ruleSetA
    } | ConvertTo-Json -Depth 6)

  $simA = Unwrap-Value $simARaw
  $simAArr = @($simA)
  if ($simAArr.Count -ne 1) {
    throw "expected 1 simulation result for A, got $($simAArr.Count)"
  }
  $recA = $simAArr[0]
  if ($recA.computed.metrics.late_minutes -le 0) {
    throw "expected late_minutes > 0 for A, got $($recA.computed.metrics.late_minutes)"
  }

  $simBRaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      start_date = $date
      end_date = $date
      rule_set_id = $ruleSetB
    } | ConvertTo-Json -Depth 6)

  $simB = Unwrap-Value $simBRaw
  $simBArr = @($simB)
  if ($simBArr.Count -ne 1) {
    throw "expected 1 simulation result for B, got $($simBArr.Count)"
  }
  $recB = $simBArr[0]
  if ($recB.computed.metrics.late_minutes -ne 0) {
    throw "expected late_minutes = 0 for B, got $($recB.computed.metrics.late_minutes)"
  }
  if ((Has-Flag $recA 'LATE') -and (Has-Flag $recB 'LATE')) {
    throw 'expected LATE flag to be cleared for B when present for A'
  }

  $postCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date" -Headers $opsHeaders
  if ($postCount.count -ne 0) {
    throw "expected count=0 after simulation, got $($postCount.count)"
  }

  Write-Host 'PASS: simulate late threshold what-if'
  exit 0
} catch {
  Write-Host 'FAIL: simulate late threshold what-if'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
