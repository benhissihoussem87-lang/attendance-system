$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$csv = @"
person_id,event_time,direction
p1,2026-01-07 08:00:00,IN
p1,2026-01-07 17:00:00,OUT
"@

try {
  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/preview" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv
  if ($res.valid_rows -le 0 -or $res.invalid_rows -ne 0) {
    Write-Host "FAIL: csv_valid"
    exit 1
  }
  Write-Host "PASS: csv_valid"
  exit 0
} catch {
  Write-Host "FAIL: csv_valid"
  exit 1
}
