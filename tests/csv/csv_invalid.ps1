$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$csv = @"
person_id,event_time,direction
,2026-01-07 08:00:00,IN
"@

try {
  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv
  if ($res.invalid_rows -le 0) {
    Write-Host "FAIL: csv_invalid"
    exit 1
  }
  Write-Host "PASS: csv_invalid"
  exit 0
} catch {
  Write-Host "FAIL: csv_invalid"
  exit 1
}
