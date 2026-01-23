$ErrorActionPreference = 'Stop'

if ($env:USE_EMPLOYEES_REGISTRY -ne '1') {
  Write-Host 'SKIP: USE_EMPLOYEES_REGISTRY not enabled'
  exit 0
}

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$date = if ($env:ATTENDANCE_DATE) { $env:ATTENDANCE_DATE } else { '2026-01-07' }

try {
  Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      employee_code = 'EMP001'
      full_name = 'Ali Ben Salah'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6) | Out-Null

  $res = Invoke-RestMethod "$baseUrl/api/attendance?date=$date&person_id=p1&company_id=DEFAULT"
  $record = if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') { $res.value[0] } else { $res[0] }

  if (-not $record) { throw 'expected attendance record' }
  if ($record.employee_code -ne 'EMP001') { throw 'expected employee_code from registry' }
  if ($record.full_name -ne 'Ali Ben Salah') { throw 'expected full_name from registry' }

  Write-Host 'PASS: employees registry display mode'
  exit 0
} catch {
  Write-Host 'FAIL: employees registry display mode'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
