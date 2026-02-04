$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_idmapnorm"

$providerUpper = 'NORMTEST'
$providerLower = 'normtest'
$typeUpper = 'PIN'
$typeLower = 'pin'
$identifierValueSpaced = " AbC123_$runSuffix "
$identifierValueTrimmed = "AbC123_$runSuffix"
$personA = "norm_test_A_$runSuffix"
$personB = "norm_test_B_$runSuffix"
$encodedPersonA = [uri]::EscapeDataString($personA)
$encodedPersonB = [uri]::EscapeDataString($personB)

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

function Invoke-JsonRequest {
  param(
    [string]$method,
    [string]$url,
    $body = $null
  )

  try {
    if ($body -ne $null) {
      $resp = Invoke-WebRequest $url `
        -Method $method `
        -ContentType 'application/json' `
        -Body ($body | ConvertTo-Json -Depth 6) `
        -UseBasicParsing
    } else {
      $resp = Invoke-WebRequest $url `
        -Method $method `
        -UseBasicParsing
    }

    $text = $resp.Content
    $json = $null
    if ($text) {
      try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
    }

    return @{
      status = [int]$resp.StatusCode
      text   = $text
      json   = $json
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    return @{
      status = $info.status
      text   = $info.text
      json   = $info.json
    }
  }
}

try {
  $mode = $null
  try {
    $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
  } catch {
    $mode = $null
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host "FAIL: identity_mappings_normalization server mode"
    Write-Host "This test requires ALLOW_TEST_ENDPOINTS=true"
    exit 1
  }

  $respA = Invoke-JsonRequest 'Put' "$baseUrl/api/employees-registry/$encodedPersonA" @{
    company_id = $companyId
    employee_code = "EMP_NORM_A_$runSuffix"
    full_name = 'Norm Test A'
    active = $true
  }
  if ($respA.status -ne 200 -and $respA.status -ne 201) {
    Write-Host "FAIL: employee registry upsert A status=$($respA.status)"
    Write-Host $respA.text
    exit 1
  }

  $respB = Invoke-JsonRequest 'Put' "$baseUrl/api/employees-registry/$encodedPersonB" @{
    company_id = $companyId
    employee_code = "EMP_NORM_B_$runSuffix"
    full_name = 'Norm Test B'
    active = $true
  }
  if ($respB.status -ne 200 -and $respB.status -ne 201) {
    Write-Host "FAIL: employee registry upsert B status=$($respB.status)"
    Write-Host $respB.text
    exit 1
  }

  $resp1 = Invoke-JsonRequest 'Put' "$baseUrl/api/identity-mappings" @{
    company_id = $companyId
    provider = $providerUpper
    identifier_type = $typeUpper
    identifier_value = $identifierValueSpaced
    person_id = $personA
    active = $true
  }
  if ($resp1.status -ne 200 -and $resp1.status -ne 201) {
    Write-Host "FAIL: mapping upsert #1 status=$($resp1.status)"
    Write-Host $resp1.text
    exit 1
  }
  if ($resp1.json -and $resp1.json.PSObject.Properties.Name -contains 'mapping_applied' -and -not $resp1.json.mapping_applied) {
    Write-Host "FAIL: mapping upsert #1 mapping_applied=false"
    Write-Host $resp1.text
    exit 1
  }

  $resp2 = Invoke-JsonRequest 'Put' "$baseUrl/api/identity-mappings" @{
    company_id = $companyId
    provider = $providerLower
    identifier_type = $typeLower
    identifier_value = $identifierValueTrimmed
    person_id = $personA
    active = $true
  }
  if ($resp2.status -ne 200) {
    Write-Host "FAIL: mapping upsert #2 status=$($resp2.status)"
    Write-Host $resp2.text
    exit 1
  }

  $query = "$baseUrl/api/identity-mappings?company_id=$companyId&provider=$providerLower&identifier_type=$typeLower&identifier_value=$identifierValueTrimmed"
  $list = Invoke-JsonRequest 'Get' $query $null
  if ($list.status -ne 200) {
    Write-Host "FAIL: mapping lookup status=$($list.status)"
    Write-Host $list.text
    exit 1
  }
  $items = @($list.json)
  if ($items.Count -ne 1) {
    Write-Host "FAIL: expected 1 row for normalized lookup, got $($items.Count)"
    Write-Host $list.text
    exit 1
  }
  $row = $items[0]
  if ($row.provider -ne $providerLower -or $row.identifier_type -ne $typeLower -or $row.identifier_value -ne $identifierValueTrimmed -or $row.person_id -ne $personA) {
    Write-Host "FAIL: unexpected row for normalized lookup"
    Write-Host ($row | ConvertTo-Json -Depth 6)
    exit 1
  }

  $resp3 = Invoke-JsonRequest 'Put' "$baseUrl/api/identity-mappings" @{
    company_id = $companyId
    provider = $providerUpper
    identifier_type = $typeUpper
    identifier_value = $identifierValueTrimmed
    person_id = $personB
    active = $true
  }
  if ($resp3.status -ne 409) {
    Write-Host "FAIL: mapping upsert #3 expected 409 got $($resp3.status)"
    Write-Host $resp3.text
    exit 1
  }
  if (-not $resp3.json -or -not $resp3.json.details -or $resp3.json.details.existing_person_id -ne $personA) {
    Write-Host "FAIL: mapping upsert #3 missing existing_person_id=$personA"
    Write-Host $resp3.text
    exit 1
  }

  Write-Host 'PASS: identity_mappings_normalization'
  exit 0
} catch {
  Write-Host 'FAIL: identity_mappings_normalization'
  Write-Host $_
  exit 1
}
