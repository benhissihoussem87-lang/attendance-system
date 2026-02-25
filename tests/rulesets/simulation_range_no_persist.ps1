$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { 'p1' }
$startDate = '2026-01-13'
$endDate = '2026-01-15'
$dateList = @($startDate, '2026-01-14', $endDate)

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
    Write-Host 'SKIP: simulate range no persist (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
      Write-Host 'SKIP: simulate range no persist (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: simulate range no persist (test endpoints disabled)'
    exit 0
  }

  foreach ($date in $dateList) {
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
        events = @()
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  foreach ($date in $dateList) {
    $preCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date" -Headers $opsHeaders
    if ($preCount.count -ne 0) {
      throw "expected count=0 before simulation for $date, got $($preCount.count)"
    }
  }

  $simRaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      person_id = $personId
      start_date = $startDate
      end_date = $endDate
    } | ConvertTo-Json -Depth 6)

  $sim = Unwrap-Value $simRaw
  $simArr = @($sim)
  if ($simArr.Count -ne 3) {
    throw "expected 3 simulation results, got $($simArr.Count)"
  }
  foreach ($record in $simArr) {
    if ($record.source -ne 'simulation') {
      throw 'expected source=simulation'
    }
    if ($record.attendance_day_id) {
      throw 'expected attendance_day_id to be null for simulation'
    }
    if (-not $record.computed -or -not $record.computed.status) {
      throw 'expected computed.status for simulation'
    }
    if (-not $record.effective -or -not $record.effective.status) {
      throw 'expected effective.status for simulation'
    }
  }

  foreach ($date in $dateList) {
    $postCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date" -Headers $opsHeaders
    if ($postCount.count -ne 0) {
      throw "expected count=0 after simulation for $date, got $($postCount.count)"
    }
  }

  Write-Host 'PASS: simulate range no persist'
  exit 0
} catch {
  Write-Host 'FAIL: simulate range no persist'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
