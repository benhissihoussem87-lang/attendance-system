$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEFAULT' }
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
$personA = ("norm_test_a_$runSuffix").ToLowerInvariant()
$personB = ("norm_test_b_$runSuffix").ToLowerInvariant()
$encodedCompanyId = [uri]::EscapeDataString($companyId)
$encodedPersonA = [uri]::EscapeDataString($personA)
$encodedPersonB = [uri]::EscapeDataString($personB)

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
    Write-Host 'SKIP: identity mappings normalization (TEST_API_KEY_* missing under REQUIRE_AUTH)'
    exit 0
  }
  if (-not $adminKey) {
    Write-Host 'SKIP: identity mappings normalization (TEST_API_KEY_ADMIN missing under REQUIRE_AUTH)'
    exit 0
  }
  if ($adminKey) { $adminHeaders['x-api-key'] = $adminKey }
  if ($opKey) {
    $operatorHeaders['x-api-key'] = $opKey
  } else {
    $operatorHeaders = @{} + $adminHeaders
  }
}

function Invoke-JsonRequest {
  param(
    [string]$method,
    [string]$url,
    $body = $null,
    [hashtable]$headers = @{}
  )

  try {
    if ($body -ne $null) {
      $resp = Invoke-WebRequest $url `
        -Method $method `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body ($body | ConvertTo-Json -Depth 6) `
        -UseBasicParsing
    } else {
      $resp = Invoke-WebRequest $url `
        -Method $method `
        -Headers $headers `
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
    if ($adminHeaders.Count -gt 0) {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode" -Headers $adminHeaders
    } else {
      $mode = Invoke-RestMethod "$baseUrl/api/ops/test/mode"
    }
  } catch {
    $probe = Get-HttpErrorInfo $_
    $status = $probe.status
    $text = if ($probe.text) { $probe.text.ToString().Trim().ToLower() } else { '' }
    $errorValue = if ($probe.json -and $probe.json.error) { $probe.json.error.ToString().Trim().ToLower() } else { '' }
    if ($status -eq 404 -or $errorValue -eq 'not_found' -or $text.Contains('not found') -or $text.Contains('allow_test_endpoints')) {
      Write-Host 'SKIP: identity mappings normalization (test endpoints disabled)'
      exit 0
    }
    throw
  }
  if (-not $mode -or -not $mode.allow_test_endpoints) {
    Write-Host 'SKIP: identity mappings normalization (test endpoints disabled)'
    exit 0
  }

  # Keep the person_id path segment explicit; PowerShell string interpolation around `?`
  # must not collapse the route param into the query string.
  $respA = Invoke-JsonRequest 'Put' "${baseUrl}/api/employees-registry/${encodedPersonA}?company_id=${encodedCompanyId}" @{
    company_id = $companyId
    employee_code = "EMP_NORM_A_$runSuffix"
    full_name = 'Norm Test A'
    active = $true
  } $operatorHeaders
  if ($respA.status -ne 200 -and $respA.status -ne 201) {
    Write-Host "FAIL: employee registry upsert A status=$($respA.status)"
    Write-Host $respA.text
    exit 1
  }
  $getA = Invoke-JsonRequest 'Get' "${baseUrl}/api/employees-registry/${encodedPersonA}?company_id=${encodedCompanyId}" $null $operatorHeaders
  if ($getA.status -ne 200) {
    Write-Host "FAIL: employee registry get A status=$($getA.status)"
    Write-Host $getA.text
    exit 1
  }
  $actualPersonA = if ($getA.json) { $getA.json.person_id } else { $null }
  $actualCompanyA = if ($getA.json) { $getA.json.company_id } else { $null }
  if ([string]::IsNullOrWhiteSpace($actualPersonA)) {
    Write-Host 'FAIL: employee registry get A person_id missing'
    Write-Host $getA.text
    exit 1
  }
  if ($actualCompanyA -and $actualCompanyA -ne $companyId) {
    Write-Host "FAIL: employee registry get A company_id mismatch expected=$companyId actual=$actualCompanyA"
    Write-Host $getA.text
    exit 1
  }

  $respB = Invoke-JsonRequest 'Put' "${baseUrl}/api/employees-registry/${encodedPersonB}?company_id=${encodedCompanyId}" @{
    company_id = $companyId
    employee_code = "EMP_NORM_B_$runSuffix"
    full_name = 'Norm Test B'
    active = $true
  } $operatorHeaders
  if ($respB.status -ne 200 -and $respB.status -ne 201) {
    Write-Host "FAIL: employee registry upsert B status=$($respB.status)"
    Write-Host $respB.text
    exit 1
  }
  $getB = Invoke-JsonRequest 'Get' "${baseUrl}/api/employees-registry/${encodedPersonB}?company_id=${encodedCompanyId}" $null $operatorHeaders
  if ($getB.status -ne 200) {
    Write-Host "FAIL: employee registry get B status=$($getB.status)"
    Write-Host $getB.text
    exit 1
  }
  $actualPersonB = if ($getB.json) { $getB.json.person_id } else { $null }
  $actualCompanyB = if ($getB.json) { $getB.json.company_id } else { $null }
  if ([string]::IsNullOrWhiteSpace($actualPersonB)) {
    Write-Host 'FAIL: employee registry get B person_id missing'
    Write-Host $getB.text
    exit 1
  }
  if ($actualCompanyB -and $actualCompanyB -ne $companyId) {
    Write-Host "FAIL: employee registry get B company_id mismatch expected=$companyId actual=$actualCompanyB"
    Write-Host $getB.text
    exit 1
  }

  $resp1 = Invoke-JsonRequest 'Put' "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" @{
    company_id = $companyId
    provider = $providerUpper
    identifier_type = $typeUpper
    identifier_value = $identifierValueSpaced
    person_id = $personA
    active = $true
  } $operatorHeaders
  if ($resp1.status -ne 200 -and $resp1.status -ne 201) {
    Write-Host "FAIL: mapping upsert #1 status=$($resp1.status)"
    Write-Host "expected company_id=$companyId requested_person_id=$personA actualPersonA=$actualPersonA actualPersonB=$actualPersonB"
    Write-Host $resp1.text
    exit 1
  }
  if ($resp1.json -and $resp1.json.PSObject.Properties.Name -contains 'mapping_applied' -and -not $resp1.json.mapping_applied) {
    Write-Host "FAIL: mapping upsert #1 mapping_applied=false"
    Write-Host $resp1.text
    exit 1
  }

  $resp2 = Invoke-JsonRequest 'Put' "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" @{
    company_id = $companyId
    provider = $providerLower
    identifier_type = $typeLower
    identifier_value = $identifierValueTrimmed
    person_id = $personA
    active = $true
  } $operatorHeaders
  if ($resp2.status -ne 200) {
    Write-Host "FAIL: mapping upsert #2 status=$($resp2.status)"
    Write-Host $resp2.text
    exit 1
  }

  $query = "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}&provider=$([uri]::EscapeDataString($providerLower))&identifier_type=$([uri]::EscapeDataString($typeLower))&identifier_value=$([uri]::EscapeDataString($identifierValueTrimmed))"
  $list = Invoke-JsonRequest 'Get' $query $null $operatorHeaders
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
  if ($row.provider -ne $providerLower -or $row.identifier_type -ne $typeLower -or $row.identifier_value -ne $identifierValueTrimmed -or $row.person_id -ne $actualPersonA) {
    Write-Host "FAIL: unexpected row for normalized lookup"
    Write-Host ($row | ConvertTo-Json -Depth 6)
    exit 1
  }

  # Reassigning the same normalized identifier to a different employee must stay a 409 conflict.
  $upsert3Body = @{
    company_id = $companyId
    provider = $providerUpper
    identifier_type = $typeUpper
    identifier_value = $identifierValueTrimmed
    person_id = $personB
    active = $true
  }
  Write-Host ("DEBUG: mapping upsert #3 body=" + (($upsert3Body | Select-Object person_id, provider, identifier_type, identifier_value | ConvertTo-Json -Compress)))
  $resp3 = Invoke-JsonRequest 'Put' "${baseUrl}/api/identity-mappings?company_id=${encodedCompanyId}" $upsert3Body $operatorHeaders
  if ($resp3.status -ne 409) {
    Write-Host "FAIL: mapping upsert #3 expected 409 got $($resp3.status)"
    Write-Host "request company_id=$companyId provider=$providerUpper identifier_type=$typeUpper identifier_value=$identifierValueTrimmed person_id=$personB"
    Write-Host $resp3.text
    exit 1
  }
  if (-not $resp3.json -or -not $resp3.json.details -or $resp3.json.details.existing_person_id -ne $actualPersonA) {
    Write-Host "FAIL: mapping upsert #3 missing existing_person_id=$actualPersonA"
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
