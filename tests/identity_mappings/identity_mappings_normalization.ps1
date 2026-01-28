$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$companyId = 'DEFAULT'
$runId = [Guid]::NewGuid().ToString('N')
$personId = "norm_test_$runId"

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

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/$personId" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        employee_code = "EMP_NORM_$runId"
        full_name = 'Norm Test'
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("employee registry upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  try {
    Invoke-RestMethod "$baseUrl/api/identity-mappings" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = $companyId
        provider = 'ZKTECO'
        identifier_type = 'PIN'
        identifier_value = ' AbC123 '
        person_id = $personId
        active = $true
      } | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
    $info = Get-HttpErrorInfo $_
    throw ("identity mapping upsert failed. status={0} body={1}" -f $info.status, $info.text)
  }

  $queryLower = "$baseUrl/api/identity-mappings?company_id=$companyId&provider=zkteco&identifier_type=pin&identifier_value=AbC123"
  $listLower = Invoke-RestMethod $queryLower -Method Get
  $itemsLower = @($listLower)
  if ($itemsLower.Count -ne 1) {
    throw ("expected 1 row for lowercase query, got {0}" -f $itemsLower.Count)
  }
  $rowLower = $itemsLower[0]
  if ($rowLower.provider -ne 'zkteco' -or $rowLower.identifier_type -ne 'pin' -or $rowLower.identifier_value -ne 'AbC123') {
    throw ("unexpected row for lowercase query: {0}" -f ($rowLower | ConvertTo-Json -Depth 6))
  }

  $queryMixed = "$baseUrl/api/identity-mappings?company_id=$companyId&provider=ZKTECO&identifier_type=PIN&identifier_value= AbC123"
  $listMixed = Invoke-RestMethod $queryMixed -Method Get
  $itemsMixed = @($listMixed)
  if ($itemsMixed.Count -ne 1) {
    throw ("expected 1 row for mixed query, got {0}" -f $itemsMixed.Count)
  }
  $rowMixed = $itemsMixed[0]
  if ($rowMixed.provider -ne 'zkteco' -or $rowMixed.identifier_type -ne 'pin' -or $rowMixed.identifier_value -ne 'AbC123') {
    throw ("unexpected row for mixed query: {0}" -f ($rowMixed | ConvertTo-Json -Depth 6))
  }

  Write-Host 'PASS: identity_mappings_normalization'
  exit 0
} catch {
  Write-Host 'FAIL: identity_mappings_normalization'
  Write-Host $_
  exit 1
}
