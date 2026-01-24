$ErrorActionPreference = 'Stop'

if ($env:USE_IDENTITY_MAPPINGS -ne '1') {
  Write-Host 'SKIP: USE_IDENTITY_MAPPINGS not enabled'
  exit 0
}

$runId = [Guid]::NewGuid().ToString('N').Substring(0, 8)

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
try {
  $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
} catch {
  $mode = $null
}
$require = if ($mode -and $mode.require_identity_mappings -is [bool]) {
  $mode.require_identity_mappings
} else {
  $env:REQUIRE_IDENTITY_MAPPINGS -eq '1'
}

function Unwrap-Value {
  param($res)

  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

function Get-HttpErrorInfo {
  param($err)

  $status = $null
  $text = $null

  try {
    $resp = $err.Exception.Response
    if ($resp -is [System.Net.HttpWebResponse]) {
      $status = [int]$resp.StatusCode
      $stream = $resp.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $text = $reader.ReadToEnd()
      }
    }
  } catch {}

  if (-not $text) {
    try {
      $resp2 = $err.Exception.Response
      if ($resp2 -and $resp2.Content) {
        $status = [int]$resp2.StatusCode
        $text = $resp2.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {}
  }

  if (-not $text) {
    try {
      if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
        $text = $err.ErrorDetails.Message
      }
    } catch {}
  }

  $json = $null
  if ($text) {
    try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
  }

  return @{
    status = $status
    text   = $text
    json   = $json
  }
}

try {
  Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT" `
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
      identifier_value = 'EXT001'
      person_id = 'p1'
      active = $true
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $csv = @"
person_id,event_time,direction,device_uid
EXT001,2026-01-07 08:00:00,IN,TEST-DEVICE-1-$runId
"@

  $preview = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv

  $previewVal = Unwrap-Value $preview
  if ($env:DEBUG_IDENTITY_INGEST_TEST -eq '1') {
    Write-Host ($previewVal | ConvertTo-Json -Depth 20)
  }

  $previewRows = $null
  if ($previewVal.sample_rows -and $previewVal.sample_rows.Count -gt 0) {
    $previewRows = $previewVal.sample_rows
  } elseif ($previewVal.sample_valid_rows -and $previewVal.sample_valid_rows.Count -gt 0) {
    $previewRows = $previewVal.sample_valid_rows
  }

  if (-not $previewRows -or $previewRows.Count -lt 1) {
    if ($env:DEBUG_IDENTITY_INGEST_TEST -eq '1') {
      Write-Host ($previewVal | ConvertTo-Json -Depth 20)
    }
    $totals = "total_rows=$($previewVal.total_rows) valid_rows=$($previewVal.valid_rows) invalid_rows=$($previewVal.invalid_rows)"
    $keys = if ($previewVal -and $previewVal.PSObject) { $previewVal.PSObject.Properties.Name -join ', ' } else { '<none>' }
    throw "expected preview sample rows; $totals; keys: $keys"
  }
  $sample = $previewRows[0].data
  if ($sample.resolved_person_id -ne 'p1') { throw 'expected resolved_person_id p1' }
  if ($sample.identity_mapping_applied -ne $true) { throw 'expected identity_mapping_applied true' }

  $commitRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=DEFAULT" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv

  $commit = Unwrap-Value $commitRaw
  if ($commit.inserted_rows -ne 1 -or $commit.skipped_rows -ne 0) {
    throw ("expected inserted_rows 1; got inserted_rows={0} skipped_rows={1}" -f $commit.inserted_rows, $commit.skipped_rows)
  }
  if (-not $commit.inserted_samples -or $commit.inserted_samples.first3.Count -lt 1) {
    throw 'expected inserted_samples'
  }
  if ($commit.inserted_samples.first3[0].person_id -ne 'p1') {
    throw 'expected inserted person_id to be canonical'
  }

  $csvMissing = @"
person_id,event_time,direction,device_uid
EXT_MISSING_$runId,2026-01-07 09:00:00,IN,TEST-DEVICE-1-missing-$runId
"@

  $previewMissingRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=DEFAULT" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csvMissing
  $previewMissing = Unwrap-Value $previewMissingRaw

  if ($require -eq $true) {
    if ($previewMissing.invalid_rows -lt 1) { throw 'expected preview invalid_rows for missing mapping' }
    $hasIdentityError = $false
    foreach ($err in $previewMissing.errors) {
      if ($err.code -eq 'identity_mapping_missing') { $hasIdentityError = $true }
    }
    if (-not $hasIdentityError) { throw 'expected identity_mapping_missing error in preview' }

    try {
      Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=DEFAULT" `
        -Method Post `
        -ContentType 'text/plain' `
        -Body $csvMissing | Out-Null
      throw 'expected commit to fail on missing mapping'
    } catch {
      $info = Get-HttpErrorInfo $_
      if ($info.status -ne 400) {
        throw ("expected HTTP 400, got {0}. body={1}" -f $info.status, $info.text)
      }
      if (-not $info.json) {
        throw ("expected JSON error body. raw={0}" -f $info.text)
      }
      if ($info.json.error -ne 'identity_mapping_missing') {
        throw ("expected identity_mapping_missing, got {0}" -f $info.json.error)
      }
    }
  } else {
    if ($previewMissing.total_rows -ne 1) { throw 'expected preview total_rows 1 for missing mapping' }
    if ($previewMissing.valid_rows -lt 1 -or $previewMissing.invalid_rows -ne 0) {
      throw 'expected preview valid row for missing mapping in non-strict mode'
    }
    $previewRowsMissing = $null
    if ($previewMissing.sample_rows -and $previewMissing.sample_rows.Count -gt 0) {
      $previewRowsMissing = $previewMissing.sample_rows
    } elseif ($previewMissing.sample_valid_rows -and $previewMissing.sample_valid_rows.Count -gt 0) {
      $previewRowsMissing = $previewMissing.sample_valid_rows
    }
    if (-not $previewRowsMissing -or $previewRowsMissing.Count -lt 1) {
      throw 'expected preview sample rows for missing mapping in non-strict mode'
    }
    $sampleMissing = $previewRowsMissing[0].data
    if ($sampleMissing.identity_mapping_applied -ne $false) {
      throw 'expected identity_mapping_applied false for missing mapping'
    }
    if (-not $sampleMissing.identity_mapping_reason) {
      throw 'expected identity_mapping_reason for missing mapping'
    }

    $commitMissingRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=DEFAULT" `
      -Method Post `
      -ContentType 'text/plain' `
      -Body $csvMissing
    $commitMissing = Unwrap-Value $commitMissingRaw
    if ($commitMissing.inserted_rows -ne 1 -or $commitMissing.skipped_rows -ne 0) {
      throw ("expected inserted_rows 1; got inserted_rows={0} skipped_rows={1}" -f $commitMissing.inserted_rows, $commitMissing.skipped_rows)
    }
  }

  Write-Host 'PASS: identity mappings ingestion mode'
  exit 0
} catch {
  Write-Host 'FAIL: identity mappings ingestion mode'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
