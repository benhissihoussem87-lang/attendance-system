$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID } else { ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId = "p1_${safeRunId}_csvscope_commit"
$encodedPersonId = [uri]::EscapeDataString($personId)
$endpoint = "$baseUrl/api/device-events/import/commit?company_id=DEFAULT"

function Invoke-CsvRequest {
  param(
    [string]$uri,
    [string]$csv
  )

  try {
    $res = Invoke-WebRequest -Uri $uri -Method Post -ContentType 'text/plain' -Body $csv -TimeoutSec 20
    $json = $null
    try { $json = $res.Content | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    return @{
      status = [int]$res.StatusCode
      body = $json
      raw = $res.Content
    }
  } catch {
    if ($_.Exception -and $_.Exception.Response) {
      $status = $_.Exception.Response.StatusCode.value__
      $text = $null
      $json = $null
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $text = $reader.ReadToEnd()
        }
      } catch {}
      if (-not $text) {
        try {
          if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $text = $_.ErrorDetails.Message
          }
        } catch {}
      }
      if ($text) {
        try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
      }
      return @{
        status = [int]$status
        body = $json
        raw = $text
      }
    }
    throw
  }
}

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

  $csvMismatch = @"
company_id,person_id,event_time,direction,device_uid
OTHER,$personId,2026-01-10 08:00:00,IN,CSV-COMMIT-001
OTHER,$personId,2026-01-10 17:00:00,OUT,CSV-COMMIT-001
"@
  $mismatch = Invoke-CsvRequest -uri $endpoint -csv $csvMismatch
  if ($mismatch.status -ne 400) {
    throw "expected HTTP 400 for mismatched csv company_id, got $($mismatch.status)"
  }
  if (-not $mismatch.body) {
    throw "expected JSON error body for mismatched csv company_id. raw=$($mismatch.raw)"
  }
  if ($mismatch.body.code -ne 'IMPORT_ERROR') {
    throw "expected IMPORT_ERROR, got $($mismatch.body.code)"
  }
  if (-not $mismatch.body.details -or $mismatch.body.details.error -ne 'company_id_mismatch') {
    throw "expected details.error company_id_mismatch, got $($mismatch.body.details.error)"
  }

  $csvMatch = @"
company_id,person_id,event_time,direction,device_uid
DEFAULT,$personId,2026-01-11 08:00:00,IN,CSV-COMMIT-002
DEFAULT,$personId,2026-01-11 17:00:00,OUT,CSV-COMMIT-002
"@
  $match = Invoke-CsvRequest -uri $endpoint -csv $csvMatch
  if ($match.status -ne 200) {
    throw "expected HTTP 200 for matching csv company_id, got $($match.status)"
  }
  if (-not $match.body -or -not ($match.body.PSObject.Properties.Name -contains 'inserted_rows')) {
    throw 'expected commit response payload with inserted_rows for matching csv company_id'
  }
  if ([int]$match.body.inserted_rows -le 0) {
    throw "expected inserted_rows > 0 for matching csv company_id, got $($match.body.inserted_rows)"
  }

  $csvNoCompany = @"
person_id,event_time,direction,device_uid
$personId,2026-01-12 08:00:00,IN,CSV-COMMIT-003
$personId,2026-01-12 17:00:00,OUT,CSV-COMMIT-003
"@
  $noCompany = Invoke-CsvRequest -uri $endpoint -csv $csvNoCompany
  if ($noCompany.status -ne 200) {
    throw "expected HTTP 200 for csv without company_id column, got $($noCompany.status)"
  }
  if (-not $noCompany.body -or -not ($noCompany.body.PSObject.Properties.Name -contains 'inserted_rows')) {
    throw 'expected commit response payload with inserted_rows for csv without company_id'
  }
  if ([int]$noCompany.body.inserted_rows -le 0) {
    throw "expected inserted_rows > 0 for csv without company_id, got $($noCompany.body.inserted_rows)"
  }

  Write-Host 'PASS: csv company_id non-authoritative commit'
  exit 0
} catch {
  Write-Host 'FAIL: csv company_id non-authoritative commit'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
