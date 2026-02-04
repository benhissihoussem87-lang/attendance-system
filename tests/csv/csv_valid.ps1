$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_csvvalid"
$personId = "p1_$runSuffix"
$encodedPersonId = [uri]::EscapeDataString($personId)
$csv = @"
person_id,event_time,direction
$personId,2026-01-07 08:00:00,IN
$personId,2026-01-07 17:00:00,OUT
"@

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }

  if ($mode -and $mode.require_identity_mappings -eq $true) {
    Invoke-RestMethod "$baseUrl/api/employees-registry/${encodedPersonId}?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null

    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        provider = 'generic'
        identifier_type = 'person_id'
        identifier_value = $personId
        person_id = $personId
        active = $true
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
  }

  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/preview" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv
  if ($env:DEBUG_CSV_TESTS -eq '1') {
    Write-Host ($res | ConvertTo-Json -Depth 10)
  }
  if ($res.valid_rows -le 0 -or $res.invalid_rows -ne 0) {
    $keys = if ($res -and $res.PSObject) { $res.PSObject.Properties.Name -join ', ' } else { '<none>' }
    Write-Host ("CSV PREVIEW DIAGNOSTIC: keys={0}" -f $keys)
    Write-Host ("CSV PREVIEW DIAGNOSTIC: total_rows={0} valid_rows={1} invalid_rows={2}" -f $res.total_rows, $res.valid_rows, $res.invalid_rows)
    if ($res.errors) {
      Write-Host "CSV PREVIEW DIAGNOSTIC: errors="
      Write-Host ($res.errors | ConvertTo-Json -Depth 10)
    }
    if ($env:DEBUG_CSV_TESTS -ne '1') {
      Write-Host ($res | ConvertTo-Json -Depth 10)
    }
    Write-Host "FAIL: csv_valid"
    exit 1
  }
  Write-Host "PASS: csv_valid"
  exit 0
} catch {
  if ($env:DEBUG_CSV_TESTS -eq '1') {
    Write-Host "CSV PREVIEW DIAGNOSTIC: exception="
    Write-Host $_
  }
  Write-Host "FAIL: csv_valid"
  exit 1
}
