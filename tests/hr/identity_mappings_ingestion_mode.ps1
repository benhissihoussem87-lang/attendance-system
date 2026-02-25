$ErrorActionPreference = 'Stop'

$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$nonce = ([guid]::NewGuid().ToString('N')).Substring(0, 6)
$runSuffix = "${safeRunId}_${nonce}_hringest"

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

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

$requireAuth = To-Bool $env:REQUIRE_AUTH
$adminHeaders = @{}
$operatorHeaders = @{}
if ($requireAuth) {
  $adminKey = if ($env:TEST_API_KEY_ADMIN) { $env:TEST_API_KEY_ADMIN.ToString().Trim() } else { '' }
  $opKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $adminKey -and -not $opKey) {
    Write-Host 'SKIP: identity mappings ingestion mode (TEST_API_KEY_* missing under REQUIRE_AUTH)'
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
try {
  if ($opsHeaders.Count -gt 0) {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $opsHeaders
  } else {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  }
} catch {
  $probe = Get-HttpErrorInfo $_
  $status = $probe.status
  $text = if ($probe.text) { $probe.text.ToString().Trim().ToLower() } else { '' }
  $errorValue = if ($probe.json -and $probe.json.error) { $probe.json.error.ToString().Trim().ToLower() } else { '' }
  if ($status -eq 404 -or $errorValue -eq 'not_found' -or $text.Contains('not found') -or $text.Contains('allow_test_endpoints')) {
    Write-Host 'SKIP: identity mappings ingestion mode (test endpoints disabled)'
    exit 0
  }
  throw
}

if (-not $mode -or -not $mode.allow_test_endpoints) {
  Write-Host 'SKIP: identity mappings ingestion mode (test endpoints disabled)'
  exit 0
}

if (-not $mode.use_identity_mappings) {
  Write-Host 'SKIP: USE_IDENTITY_MAPPINGS not enabled'
  exit 0
}

$require = $mode.require_identity_mappings -eq $true
$policy = if ($mode.identity_mapping_policy) { $mode.identity_mapping_policy } else { 'all' }
$policy = $policy.ToString().Trim().ToLower()

function Unwrap-Value {
  param($res)

  if ($res -and $res.PSObject -and $res.PSObject.Properties.Name -contains 'value') {
    return $res.value
  }
  return $res
}

function Get-FirstRowWithErrorCode {
  param($preview, $code)

  $rows = $null
  if ($preview -and $preview.sample_rows) {
    $rows = $preview.sample_rows
  } elseif ($preview -and $preview.rows) {
    $rows = $preview.rows
  }

  if (-not $rows) {
    return $null
  }

  foreach ($row in $rows) {
    $errors = $row.errors
    if (-not $errors -and $row.data -and $row.data.errors) {
      $errors = $row.data.errors
    }
    foreach ($err in @($errors)) {
      if ($err -and $err.code -eq $code) {
        return $row
      }
    }
  }

  return $null
}

function Get-ErrorCodes {
  param($preview)

  $codes = @()
  if ($preview -and $preview.errors) {
    foreach ($err in $preview.errors) {
      if ($err -and $err.code) {
        $codes += $err.code
      }
    }
  }
  return @($codes | Select-Object -Unique)
}

function Dump-PreviewDiagnostics {
  param($label, $preview, $extra = @{})

  Write-Host ("DIAG: {0}" -f $label)
  if (-not $preview) {
    Write-Host "DIAG: preview is null"
    if ($extra -and $extra.Count -gt 0) {
      Write-Host ("DIAG: extra=" + ($extra | ConvertTo-Json -Depth 12))
    }
    return
  }

  $total = $preview.total_rows
  $valid = $preview.valid_rows
  $invalid = $preview.invalid_rows
  Write-Host ("DIAG: totals total_rows={0} valid_rows={1} invalid_rows={2}" -f $total, $valid, $invalid)

  $codes = Get-ErrorCodes $preview
  if ($codes.Count -gt 0) {
    Write-Host ("DIAG: error_codes=" + (($codes | Select-Object -First 5) -join ', '))
  }

  if ($preview.rows) {
    $invalidRows = @($preview.rows | Where-Object { $_ -and $_.valid -eq $false })
    if ($invalidRows.Count -gt 0) {
      $firstInvalid = $invalidRows[0]
      $firstErrors = @()
      if ($firstInvalid.errors) {
        $firstErrors = @($firstInvalid.errors | ForEach-Object { $_.code })
      }
      Write-Host ("DIAG: invalid_rows_count={0} first_invalid_row={1} first_invalid_error_codes={2}" -f `
        $invalidRows.Count, $firstInvalid.row_number, ($firstErrors -join ', '))
    }
  }

  if ($preview.sample_rows -and $preview.sample_rows.Count -gt 0) {
    $sample = $preview.sample_rows[0]
    $sampleData = $sample.data
    $keys = if ($sampleData -and $sampleData.PSObject) { $sampleData.PSObject.Properties.Name -join ', ' } else { '<none>' }
    Write-Host ("DIAG: sample_keys={0}" -f $keys)
    if ($sampleData) {
      if ($sampleData.PSObject.Properties.Name -contains 'identity_mapping_applied') {
        Write-Host ("DIAG: sample_identity_mapping_applied={0}" -f $sampleData.identity_mapping_applied)
      }
      if ($sampleData.PSObject.Properties.Name -contains 'resolved_person_id') {
        Write-Host ("DIAG: sample_resolved_person_id={0}" -f $sampleData.resolved_person_id)
      }
    }
  }

  if ($extra -and $extra.Count -gt 0) {
    Write-Host ("DIAG: extra=" + ($extra | ConvertTo-Json -Depth 12))
  }
}

try {
  $companyId = 'DEFAULT'
  $personVendor = "ingest_vendor_$runSuffix"
  $personGeneric = "ingest_generic_$runSuffix"
  $vendorProvider = 'zkteco'
  $vendorIdentifier = "ZK_$runSuffix"
  $genericProvider = 'generic'
  $genericIdentifier = "GEN_$runSuffix"

  $encodedVendorId = [uri]::EscapeDataString($personVendor)
  $vendorEmployeeUrl = "$baseUrl/api/employees-registry/${encodedVendorId}?company_id=$companyId"
  $escapedVendorId = [regex]::Escape($encodedVendorId)
  if ($vendorEmployeeUrl -notmatch "/$escapedVendorId\?company_id=") {
    throw ("expected vendor employee URL to include /{0}?company_id=. personId={0} url={1}" -f $personVendor, $vendorEmployeeUrl)
  }

  Invoke-RestMethod $vendorEmployeeUrl `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $csvMissingVendor = @"
badgenumber,checktime,checktype,sn
$vendorIdentifier,2026-01-07 08:00:00,I,TEST-SN-$runSuffix
"@

  $vendorHeaders = @{} + $operatorHeaders
  $vendorHeaders['x-vendor'] = $vendorProvider

  $previewMissingVendorRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=$companyId" `
    -Method Post `
    -Headers $vendorHeaders `
    -ContentType 'text/plain' `
    -Body $csvMissingVendor
  $previewMissingVendor = Unwrap-Value $previewMissingVendorRaw

  if ($previewMissingVendor.total_rows -lt 1) { throw 'expected preview total_rows >= 1 for vendor missing mapping' }
  $hasUnknownChecktype = $false
  if ($previewMissingVendor.errors) {
    foreach ($err in $previewMissingVendor.errors) {
      if ($err.code -eq 'UNKNOWN_CHECKTYPE') { $hasUnknownChecktype = $true }
    }
  }
  if ($hasUnknownChecktype) {
    Dump-PreviewDiagnostics 'missing vendor mapping preview' $previewMissingVendor @{
      require = $require
      policy = $policy
      vendor = $vendorProvider
      companyId = $companyId
    }
    throw 'unexpected UNKNOWN_CHECKTYPE in vendor preview; server is missing ZKTECO_CHECKTYPE_MAP; set it when starting the server or use smoke.ps1 -AutoStartServer'
  }
  $hasMissingColumn = $false
  if ($previewMissingVendor.errors) {
    foreach ($err in $previewMissingVendor.errors) {
      if ($err.code -eq 'MISSING_REQUIRED_COLUMN') { $hasMissingColumn = $true }
    }
  }
  if ($hasMissingColumn) { throw 'unexpected MISSING_REQUIRED_COLUMN for vendor CSV' }

  if ($require -eq $true) {
    if ($previewMissingVendor.invalid_rows -lt 1) {
      Dump-PreviewDiagnostics 'missing vendor mapping preview' $previewMissingVendor @{
        require = $require
        policy = $policy
        vendor = $vendorProvider
        companyId = $companyId
      }
      throw 'expected preview invalid_rows for missing vendor mapping'
    }
    $hasIdentityError = $false
    foreach ($err in $previewMissingVendor.errors) {
      if ($err.code -eq 'identity_mapping_missing') { $hasIdentityError = $true }
    }
    if (-not $hasIdentityError) {
      Dump-PreviewDiagnostics 'missing vendor mapping preview' $previewMissingVendor @{
        require = $require
        policy = $policy
        vendor = $vendorProvider
        companyId = $companyId
      }
      throw 'expected identity_mapping_missing error for vendor preview'
    }
  } else {
    if ($previewMissingVendor.total_rows -ne 1) { throw 'expected preview total_rows 1 for vendor missing mapping' }
    if ($previewMissingVendor.valid_rows -lt 1 -or $previewMissingVendor.invalid_rows -ne 0) {
      throw 'expected preview valid row for vendor missing mapping in non-strict mode'
    }
    $previewRowsVendor = $null
    if ($previewMissingVendor.sample_rows -and $previewMissingVendor.sample_rows.Count -gt 0) {
      $previewRowsVendor = $previewMissingVendor.sample_rows
    } elseif ($previewMissingVendor.sample_valid_rows -and $previewMissingVendor.sample_valid_rows.Count -gt 0) {
      $previewRowsVendor = $previewMissingVendor.sample_valid_rows
    }
    if (-not $previewRowsVendor -or $previewRowsVendor.Count -lt 1) {
      throw 'expected preview sample rows for vendor missing mapping in non-strict mode'
    }
    $sampleVendorMissing = $previewRowsVendor[0].data
    if ($sampleVendorMissing.identity_mapping_applied -ne $false) {
      throw 'expected identity_mapping_applied false for vendor missing mapping'
    }
  }

  Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=$companyId" `
    -Method Put `
    -Headers $operatorHeaders `
    -ContentType 'application/json' `
    -Body (@{
      provider = $vendorProvider
      identifier_type = 'pin'
      identifier_value = $vendorIdentifier
      person_id = $personVendor
      active = $true
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $csv = @"
badgenumber,checktime,checktype,sn
$vendorIdentifier,2026-01-07 08:00:00,I,TEST-SN-$runSuffix
"@

  $preview = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=$companyId" `
    -Method Post `
    -Headers $vendorHeaders `
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
  if ($sample.resolved_person_id -ne $personVendor) { throw 'expected resolved_person_id for vendor mapping' }
  if ($sample.identity_mapping_applied -ne $true) { throw 'expected identity_mapping_applied true' }
  if (-not $sample.raw_payload -or -not $sample.raw_payload.identity) {
    throw 'expected raw_payload.identity in preview'
  }
  if ($sample.raw_payload.identity.mapping_applied -ne $true) {
    throw 'expected raw_payload.identity.mapping_applied true'
  }

  $commitRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=$companyId" `
    -Method Post `
    -Headers $vendorHeaders `
    -ContentType 'text/plain' `
    -Body $csv

  $commit = Unwrap-Value $commitRaw
  if ($commit.inserted_rows -ne 1 -or $commit.skipped_rows -ne 0) {
    throw ("expected inserted_rows 1; got inserted_rows={0} skipped_rows={1}" -f $commit.inserted_rows, $commit.skipped_rows)
  }
  if (-not $commit.inserted_samples -or $commit.inserted_samples.first3.Count -lt 1) {
    throw 'expected inserted_samples'
  }
  if ($commit.inserted_samples.first3[0].person_id -ne $personVendor) {
    throw 'expected inserted person_id to be canonical'
  }

  if ($policy -eq 'all') {
    $encodedGenericId = [uri]::EscapeDataString($personGeneric)
    $genericEmployeeUrl = "$baseUrl/api/employees-registry/${encodedGenericId}?company_id=$companyId"
    $escapedGenericId = [regex]::Escape($encodedGenericId)
    if ($genericEmployeeUrl -notmatch "/$escapedGenericId\?company_id=") {
      throw ("expected generic employee URL to include /{0}?company_id=. personId={0} url={1}" -f $personGeneric, $genericEmployeeUrl)
    }

    Invoke-RestMethod $genericEmployeeUrl `
      -Method Put `
      -Headers $operatorHeaders `
      -ContentType 'application/json' `
      -Body (@{
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null

    $csvMissingGeneric = @"
person_id,event_time,direction,device_uid
$genericIdentifier,2026-01-07 09:00:00,IN,TEST-DEVICE-1-generic-$runSuffix
"@

    $genericHeaders = @{} + $operatorHeaders
    $genericHeaders['x-vendor'] = $genericProvider

    $previewMissingGenericRaw = Invoke-RestMethod "$baseUrl/api/device-events/import/preview?company_id=$companyId" `
      -Method Post `
      -Headers $genericHeaders `
      -ContentType 'text/plain' `
      -Body $csvMissingGeneric
    $previewMissingGeneric = Unwrap-Value $previewMissingGenericRaw

    if ($require -eq $true) {
      if ($previewMissingGeneric.invalid_rows -lt 1) {
        Dump-PreviewDiagnostics 'missing generic mapping preview' $previewMissingGeneric @{
          require = $require
          policy = $policy
          vendor = $genericProvider
          companyId = $companyId
        }
        throw 'expected preview invalid_rows for missing generic mapping'
      }
      $hasIdentityError = $false
      foreach ($err in $previewMissingGeneric.errors) {
        if ($err.code -eq 'identity_mapping_missing') { $hasIdentityError = $true }
      }
      if (-not $hasIdentityError) {
        Dump-PreviewDiagnostics 'missing generic mapping preview' $previewMissingGeneric @{
          require = $require
          policy = $policy
          vendor = $genericProvider
          companyId = $companyId
        }
        throw 'expected identity_mapping_missing error in generic preview'
      }
    } else {
      if ($previewMissingGeneric.total_rows -ne 1) { throw 'expected preview total_rows 1 for generic missing mapping' }
      if ($previewMissingGeneric.valid_rows -lt 1 -or $previewMissingGeneric.invalid_rows -ne 0) {
        throw 'expected preview valid row for generic missing mapping in non-strict mode'
      }
      $previewRowsMissing = $null
      if ($previewMissingGeneric.sample_rows -and $previewMissingGeneric.sample_rows.Count -gt 0) {
        $previewRowsMissing = $previewMissingGeneric.sample_rows
      } elseif ($previewMissingGeneric.sample_valid_rows -and $previewMissingGeneric.sample_valid_rows.Count -gt 0) {
        $previewRowsMissing = $previewMissingGeneric.sample_valid_rows
      }
      if (-not $previewRowsMissing -or $previewRowsMissing.Count -lt 1) {
        throw 'expected preview sample rows for generic missing mapping in non-strict mode'
      }
      $sampleMissing = $previewRowsMissing[0].data
      if ($sampleMissing.identity_mapping_applied -ne $false) {
        throw 'expected identity_mapping_applied false for generic missing mapping'
      }
    }
  } else {
    Write-Host "SKIP: generic provider scenario (identity mapping policy is $policy)"
  }

  Write-Host 'PASS: identity mappings ingestion mode'
  exit 0
} catch {
  Write-Host 'FAIL: identity mappings ingestion mode'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
