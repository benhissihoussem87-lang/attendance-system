$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
$runId = $env:CI_RUN_ID
if (-not $runId) { $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) { $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 8) }
$runSuffix = "${safeRunId}_hrreg"
$employeeCode = "EMP001_$runSuffix"
# Suffix employee_code to avoid CI collisions across parallel runs.
$personId = "employee_registry_$runSuffix"
$externalId = "EXT_$runSuffix"
$personIdP1 = "p1"
$personIdP2 = "p2"
$encodedPersonId = [uri]::EscapeDataString($personId)
$encodedPersonIdP1 = [uri]::EscapeDataString($personIdP1)
$encodedPersonIdP2 = [uri]::EscapeDataString($personIdP2)

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
$authHeaders = @{}
if ($requireAuth) {
  $operatorKey = if ($env:TEST_API_KEY_OPERATOR) { $env:TEST_API_KEY_OPERATOR.ToString().Trim() } else { '' }
  if (-not $operatorKey) {
    Write-Host 'FAIL: employees registry'
    Write-Host 'TEST_API_KEY_OPERATOR is required when REQUIRE_AUTH is enabled'
    exit 1
  }
  $authHeaders['x-api-key'] = $operatorKey
}

try {
  $putOne = Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonIdP1, 'DEFAULT') `
    -Method Put `
    -Headers $authHeaders `
    -ContentType 'application/json' `
    -Body (@{
      employee_code = $employeeCode
      full_name = 'Ali Ben Salah'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6)

  $getOne = Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonIdP1, 'DEFAULT') `
    -Headers $authHeaders
  if ($getOne.company_id -ne 'DEFAULT') { throw 'expected company_id DEFAULT' }
  if (-not $getOne.person_id -or [string]::IsNullOrWhiteSpace($getOne.person_id)) {
    throw ("expected person_id to be present. response={0}" -f ($getOne | ConvertTo-Json -Depth 6))
  }
  if ($getOne.employee_code -ne $employeeCode) { throw 'expected employee_code to match run id' }
  if ($getOne.full_name -ne 'Ali Ben Salah') { throw 'expected full_name Ali Ben Salah' }
  if ($getOne.metadata.dept -ne 'IT') { throw 'expected metadata.dept IT' }

  $personUrl = ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonId, 'DEFAULT')
  $expectedSegment = "/${encodedPersonId}?company_id="
  if ($personUrl -notlike "*$expectedSegment*") {
    throw ("expected person URL to include {0}. personId={1} encodedPersonId={2} personUrl={3}" -f $expectedSegment, $personIdP1, $encodedPersonIdP1, $personUrl)
  }

  $putRun = Invoke-RestMethod $personUrl `
    -Method Put `
    -Headers $authHeaders `
    -ContentType 'application/json' `
    -Body (@{
      full_name = 'Registry Run Test'
      metadata = @{}
    } | ConvertTo-Json -Depth 6)
  if ($putRun.person_id -ne $personId) { throw 'expected PUT response person_id to match path param' }

  $getRun = Invoke-RestMethod $personUrl `
    -Headers $authHeaders
  if ($getRun.person_id -ne $personId) { throw 'expected GET person_id to match path param' }

  $identityUpsert = Invoke-RestMethod "$baseUrl/api/identity-mappings?company_id=DEFAULT" `
    -Method Put `
    -Headers $authHeaders `
    -ContentType 'application/json' `
    -Body (@{
      provider = 'generic'
      identifier_type = 'person_id'
      identifier_value = $externalId
      person_id = $personId
      active = $true
      metadata = @{}
    } | ConvertTo-Json -Depth 6)
  if ($identityUpsert.person_id -ne $personId) { throw 'expected identity mapping upsert to succeed for person_id' }

  $putTwo = Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonIdP1, 'DEFAULT') `
    -Method Put `
    -Headers $authHeaders `
    -ContentType 'application/json' `
    -Body (@{
      full_name = 'Ali Ben Salah Updated'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6)

  $getTwo = Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonIdP1, 'DEFAULT') `
    -Headers $authHeaders
  if ($getTwo.full_name -ne 'Ali Ben Salah Updated') { throw 'expected updated full_name' }

  try {
    Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, $encodedPersonIdP2, 'DEFAULT') `
      -Method Put `
      -Headers $authHeaders `
      -ContentType 'application/json' `
      -Body (@{
        employee_code = $employeeCode
        metadata = @{
          dept = 'HR'
        }
      } | ConvertTo-Json -Depth 6) | Out-Null
    throw 'expected employee_code conflict'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.status -ne 409) {
      throw ("expected HTTP 409, got {0}. body={1}" -f $info.status, $info.text)
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($info.json.code -ne 'CONFLICT') {
      throw ("expected CONFLICT code, got {0}" -f $info.json.code)
    }
    if (-not $info.json.details -or $info.json.details.kind -ne 'conflict') {
      throw 'expected details.kind=conflict'
    }
    if ($info.json.details.error -ne 'employee_code_conflict') {
      throw ("expected employee_code_conflict, got {0}" -f $info.json.details.error)
    }
  }

  try {
    Invoke-RestMethod ("{0}/api/employees-registry/{1}?company_id={2}" -f $baseUrl, 'p3', 'DEFAULT') `
      -Method Put `
      -Headers $authHeaders `
      -ContentType 'application/json' `
      -Body (@{
        company_id = 'OTHER'
        metadata = @{}
      } | ConvertTo-Json -Depth 6) | Out-Null
    throw 'expected company_id mismatch'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($requireAuth) {
      if ($info.status -ne 403) {
        throw ("expected HTTP 403, got {0}. body={1}" -f $info.status, $info.text)
      }
    } else {
      if ($info.status -ne 400) {
        throw ("expected HTTP 400, got {0}. body={1}" -f $info.status, $info.text)
      }
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($requireAuth) {
      if ($info.json.code -ne 'FORBIDDEN') {
        throw ("expected FORBIDDEN, got {0}" -f $info.json.code)
      }
      if (-not $info.json.details -or $info.json.details.kind -ne 'authz') {
        throw 'expected details.kind=authz'
      }
      if ($info.json.details.error -ne 'company_mismatch') {
        throw ("expected company_mismatch, got {0}" -f $info.json.details.error)
      }
    } else {
      if ($info.json.code -ne 'VALIDATION_ERROR') {
        throw ("expected VALIDATION_ERROR, got {0}" -f $info.json.code)
      }
      if (-not $info.json.details -or $info.json.details.kind -ne 'validation') {
        throw 'expected details.kind=validation'
      }
      $allowedValidationErrors = @('invalid_request', 'company_id_mismatch', 'company_id_required')
      if ($allowedValidationErrors -notcontains $info.json.details.error) {
        throw ("expected one of {0}, got {1}" -f ($allowedValidationErrors -join ', '), $info.json.details.error)
      }
    }
  }

  Write-Host 'PASS: employees registry'
  exit 0
} catch {
  Write-Host 'FAIL: employees registry'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
