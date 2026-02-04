$ErrorActionPreference = 'Stop'

if ($env:USE_EMPLOYEES_REGISTRY -ne '1') {
  Write-Host 'SKIP: USE_EMPLOYEES_REGISTRY not enabled'
  exit 0
}

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
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

try {
  Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      employee_code = $employeeCode
      full_name = 'Ali Ben Salah'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6) | Out-Null

  $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=$personId&company_id=DEFAULT"
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
