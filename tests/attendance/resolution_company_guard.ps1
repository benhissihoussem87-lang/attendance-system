$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-13' }

function Unwrap-Value {
  param($res)
  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

function Invoke-StatusCode {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Body
  )

  try {
    if ($Body) {
      $res = Invoke-WebRequest -Uri $Uri -Method $Method -Body $Body -ContentType 'application/json' -TimeoutSec 20
    } else {
      $res = Invoke-WebRequest -Uri $Uri -Method $Method -TimeoutSec 20
    }
    return [int]$res.StatusCode
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      return $_.Exception.Response.StatusCode.value__
    }
    throw
  }
}

try {
  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -ContentType 'application/json' `
    -Body (@{
      company_id = 'DEFAULT'
      company_timezone = 'Africa/Tunis'
      night_shift_enabled = $false
      day_start_time = '04:00'
      person_id = 'p1'
      date = $date
      events = @()
    } | ConvertTo-Json -Depth 6) | Out-Null

  $attendanceRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1&company_id=DEFAULT"
  $attendanceVal = Unwrap-Value $attendanceRaw
  $attendanceArr = @($attendanceVal)
  if (-not $attendanceArr -or $attendanceArr.Count -eq 0) {
    throw 'resolution guard: no attendance data returned'
  }

  $attendanceDayId = $attendanceArr[0].attendance_day_id
  if (-not $attendanceDayId) {
    throw 'resolution guard: attendance_day_id is missing'
  }

  $mismatchBody = @{
    company_id = 'OTHER'
    decided_by = 'HR1'
    effective_status = 'EXCUSED'
    reason_code = 'TENANT_SCOPE'
  } | ConvertTo-Json -Depth 6

  $postMismatchStatus = Invoke-StatusCode `
    -Method 'POST' `
    -Uri "$baseUrl/api/attendance/$attendanceDayId/resolutions" `
    -Body $mismatchBody
  if ($postMismatchStatus -ne 404) {
    throw "resolution guard: expected 404 for POST company mismatch, got $postMismatchStatus"
  }

  $validBody = @{
    company_id = 'DEFAULT'
    decided_by = 'HR1'
    effective_status = 'EXCUSED'
    reason_code = 'TENANT_OK'
  } | ConvertTo-Json -Depth 6

  $createRes = Invoke-RestMethod "$baseUrl/api/attendance/$attendanceDayId/resolutions" `
    -Method Post `
    -ContentType 'application/json' `
    -Body $validBody
  if (-not $createRes -or -not $createRes.id) {
    throw 'resolution guard: expected successful in-scope resolution create'
  }

  $getMismatchStatus = Invoke-StatusCode `
    -Method 'GET' `
    -Uri "$baseUrl/api/attendance/$attendanceDayId/resolutions?company_id=OTHER"
  if ($getMismatchStatus -ne 404) {
    throw "resolution guard: expected 404 for GET company mismatch, got $getMismatchStatus"
  }

  $historyRaw = Invoke-RestMethod "$baseUrl/api/attendance/$attendanceDayId/resolutions?company_id=DEFAULT"
  $historyVal = Unwrap-Value $historyRaw
  $historyArr = @($historyVal)
  if (-not $historyArr -or $historyArr.Count -eq 0) {
    throw 'resolution guard: expected in-scope resolution history rows'
  }
  $createdId = [string]$createRes.id
  $matching = $historyArr | Where-Object { [string]$_.id -eq $createdId }
  if (-not $matching) {
    throw 'resolution guard: created resolution not found in in-scope history'
  }

  Write-Host 'PASS: attendance resolution company guard'
  exit 0
} catch {
  Write-Host 'FAIL: attendance resolution company guard'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
