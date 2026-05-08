$ErrorActionPreference = 'Stop'

if ($env:USE_EMPLOYEES_REGISTRY -ne '1') {
  Write-Host 'SKIP: USE_EMPLOYEES_REGISTRY not enabled'
  exit 0
}

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_hrregdisp"
$employeeCode = "EMP001_$runSuffix"
# Suffix employee_code to avoid CI collisions across parallel runs.
$personId = "p1_$runSuffix"
$encodedPersonId = [uri]::EscapeDataString($personId)
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-07' }

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
$authHeaders = @{}
if ($requireAuth) {
  $operatorKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $operatorKey) {
    Write-Host 'SKIP: employees registry display mode (TEST_API_KEY_OPERATOR missing under REQUIRE_AUTH)'
    exit 0
  }
  $authHeaders['x-api-key'] = $operatorKey
}

try {
  Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=$([uri]::EscapeDataString($companyId))" `
    -Method Put `
    -Headers $authHeaders `
    -ContentType 'application/json' `
    -Body (@{
      employee_code = $employeeCode
      full_name = 'Ali Ben Salah'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6) | Out-Null

  $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&company_id=$([uri]::EscapeDataString($companyId))" `
    -Headers $authHeaders
  $record = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value[0] } else { $res[0] }

  if (-not $record) { throw 'expected attendance record' }
  if ($record.employee_code -ne $employeeCode) { throw 'expected employee_code from registry' }
  if ($record.full_name -ne 'Ali Ben Salah') { throw 'expected full_name from registry' }

  Write-Host 'PASS: employees registry display mode'
  exit 0
} catch {
  Write-Host 'FAIL: employees registry display mode'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
