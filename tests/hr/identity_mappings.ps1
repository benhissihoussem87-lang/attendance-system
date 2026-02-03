$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$personId1 = "p1-$runId"
$personId2 = "p2-$runId"
$identifierValue = "123-$runId"

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
  Invoke-RestMethod "$baseUrl/api/employees-registry/$personId1?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  $create = Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      provider = 'zkteco'
      identifier_type = 'pin'
        identifier_value = $identifierValue
        person_id = $personId1
        metadata = @{}
      } | ConvertTo-Json -Depth 6)

  if ($create.person_id -ne $personId1) { throw 'expected person_id to match run id' }

  $lookup = Invoke-RestMethod "$baseUrl/api/identity-mappings/lookup?company_id=DEFAULT&provider=zkteco&identifier_type=pin&identifier_value=$identifierValue"
  if ($lookup.person_id -ne $personId1) { throw 'expected lookup person_id to match run id' }

  Invoke-RestMethod "$baseUrl/api/employees-registry/$personId2?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      metadata = @{}
    } | ConvertTo-Json -Depth 6) | Out-Null

  try {
    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        provider = 'zkteco'
        identifier_type = 'pin'
        identifier_value = $identifierValue
        person_id = $personId2
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
    throw 'expected conflict on reassignment'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.status -ne 409) {
      throw ("expected HTTP 409, got {0}. body={1}" -f $info.status, $info.text)
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($info.json.error -ne 'conflict') {
      throw ("expected conflict error, got {0}" -f $info.json.error)
    }
    if ($info.json.code -ne 'CONFLICT') {
      throw ("expected code CONFLICT, got {0}" -f $info.json.code)
    }
  }

  try {
    Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = 'OTHER'
        provider = 'zkteco'
        identifier_type = 'pin'
        identifier_value = '999'
        person_id = $personId1
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
    throw 'expected company_id mismatch'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.status -ne 400) {
      throw ("expected HTTP 400, got {0}. body={1}" -f $info.status, $info.text)
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($info.json.error -ne 'bad_request') {
      throw ("expected bad_request, got {0}" -f $info.json.error)
    }
    if ($info.json.code -ne 'VALIDATION_ERROR') {
      throw ("expected code VALIDATION_ERROR, got {0}" -f $info.json.code)
    }
    if ($info.json.details.kind -ne 'validation') {
      throw ("expected details.kind validation, got {0}" -f $info.json.details.kind)
    }
  }

  $list = Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT&provider=zkteco"
  if (-not $list -or $list.Count -lt 1) { throw 'expected at least one mapping' }

  Write-Host 'PASS: identity mappings'
  exit 0
} catch {
  Write-Host 'FAIL: identity mappings'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
