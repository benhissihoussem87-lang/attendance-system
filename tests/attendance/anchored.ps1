$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-07' }
$goldenPath = Join-Path $PSScriptRoot '..\golden\attendance_anchored.json'

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
    contract = $record.contract
    engine_contract = $record.engine_contract
    engine_version = $record.engine_version
    system_version = $record.system_version
    employee = $record.employee
    status = $record.status
    first_in = $record.first_in
    last_out = $record.last_out
    worked_minutes = $record.worked_minutes
    late_minutes = $record.late_minutes
    source = $record.source
    explanation = $record.explanation
  }
}

try {
  $resetBody = @{
    company_id = 'DEFAULT'
    company_timezone = 'Africa/Tunis'
    night_shift_enabled = $true
    day_start_time = '04:00'
    person_id = 'p1'
    date = $date
    events = @(
      @{ event_time_utc = '2026-01-07T06:00:00.000Z'; direction = 'IN'; device_uid = '' },
      @{ event_time_utc = '2026-01-07T16:00:00.000Z'; direction = 'OUT'; device_uid = '' }
    )
  }
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body ($resetBody | ConvertTo-Json -Depth 5) | Out-Null

  Invoke-RestMethod "$baseUrl/api/attendance?date=$date" | Out-Null
  $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date"
  $expectedRaw = Get-Content -Raw $goldenPath
  $expected = $expectedRaw | ConvertFrom-Json

  $actualSource = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value } else { $res }
  $expectedSource = if ($expected -and $expected.PSObject -and $expected.PSObject.Properties.Name -contains 'value') { $expected.value } else { $expected }

  $actualArr = @($actualSource) | ForEach-Object { Filter-AttendanceRecord $_ }
  $expectedArr = @($expectedSource) | ForEach-Object { Filter-AttendanceRecord $_ }

  $normActual = Normalize-Object $actualArr | ConvertTo-Json -Depth 10 -Compress
  $normExpected = Normalize-Object $expectedArr | ConvertTo-Json -Depth 10 -Compress

  if ($normActual -ne $normExpected) {
    Write-Host "---- ACTUAL (normalized) ----"
    Write-Host (Normalize-Object $actualArr | ConvertTo-Json -Depth 10)
    Write-Host ""
    Write-Host "---- EXPECTED (normalized) ----"
    Write-Host (Normalize-Object $expectedArr | ConvertTo-Json -Depth 10)
    Write-Host ""
    Write-Host "FAIL: attendance anchored mismatch"
    throw "attendance anchored mismatch"
  }
  Write-Host "PASS: attendance anchored"
  exit 0
}catch {
  Write-Host "FAIL: attendance anchored"
  Write-Host "---- ERROR ----"
  Write-Host $_
  exit 1
}
