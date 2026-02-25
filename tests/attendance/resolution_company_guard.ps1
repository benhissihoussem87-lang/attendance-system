$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-13' }

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
    Write-Host 'SKIP: attendance resolution company guard (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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

function Invoke-StatusCode {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Body,
    [hashtable]$Headers = @{}
  )

  try {
    if ($Body) {
      $res = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -Body $Body -ContentType 'application/json' -TimeoutSec 20
    } else {
      $res = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -TimeoutSec 20
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
      Write-Host 'SKIP: attendance resolution company guard (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: attendance resolution company guard (test endpoints disabled)'
    exit 0
  }

  Invoke-RestMethod "$baseUrl/api/ops/test/reset" `
    -Method Post `
    -Headers $opsHeaders `
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

  $attendanceRaw = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1&company_id=DEFAULT" -Headers $operatorHeaders
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
    -Body $mismatchBody `
    -Headers $operatorHeaders
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
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body $validBody
  if (-not $createRes -or -not $createRes.id) {
    throw 'resolution guard: expected successful in-scope resolution create'
  }

  $getMismatchStatus = Invoke-StatusCode `
    -Method 'GET' `
    -Uri "$baseUrl/api/attendance/$attendanceDayId/resolutions?company_id=OTHER" `
    -Headers $operatorHeaders
  if ($getMismatchStatus -ne 404) {
    throw "resolution guard: expected 404 for GET company mismatch, got $getMismatchStatus"
  }

  $historyRaw = Invoke-RestMethod "$baseUrl/api/attendance/$attendanceDayId/resolutions?company_id=DEFAULT" -Headers $operatorHeaders
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
