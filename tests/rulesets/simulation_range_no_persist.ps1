$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = if ($env:ATTENDANCE_PERSON_ID) { $env:ATTENDANCE_PERSON_ID } else { "p1-$runId" }
$startDate = '2026-01-13'
$endDate = '2026-01-15'
$dateList = @($startDate, '2026-01-14', $endDate)

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

try {
  foreach ($date in $dateList) {
    Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
      -Method Post `
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
    $preCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
    if ($preCount.count -ne 0) {
      throw "expected count=0 before simulation for $date, got $($preCount.count)"
    }
  }

  $simRaw = Invoke-RestMethod "$baseUrl/api/simulate/range" `
    -Method Post `
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
    $postCount = Invoke-RestMethod "$baseUrl/api/ops/test/attendance-days/count?person_id=$personId&work_date=$date"
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
