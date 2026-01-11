$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$person = "ps_" + [guid]::NewGuid().ToString("N")
$csv = @"
person_id,event_time,direction
$person,2026-01-07T08:00:00Z,IN
$person,2026-01-07T17:00:00Z,OUT
"@

try {
  $first = Invoke-RestMethod "$baseUrl/api/device-events/import/commit" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv
  if (($first.inserted_rows + $first.failed_rows) -ne $first.total_rows) {
    Write-Host "FAIL: csv_dedup first insert"
    exit 1
  }

  $second = Invoke-RestMethod "$baseUrl/api/device-events/import/commit" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv
  if ($second.inserted_rows -ne 0 -or ($second.skipped_rows + $second.failed_rows) -ne $second.total_rows) {
    Write-Host "FAIL: csv_dedup second insert"
    exit 1
  }

  Write-Host "PASS: csv_dedup"
  exit 0
} catch {
  Write-Host "FAIL: csv_dedup"
  exit 1
}
