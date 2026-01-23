$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

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
  $putOne = Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      employee_code = 'EMP001'
      full_name = 'Ali Ben Salah'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6)

  $getOne = Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT"
  if ($getOne.company_id -ne 'DEFAULT') { throw 'expected company_id DEFAULT' }
  if ($getOne.person_id -ne 'p1') { throw 'expected person_id p1' }
  if ($getOne.employee_code -ne 'EMP001') { throw 'expected employee_code EMP001' }
  if ($getOne.full_name -ne 'Ali Ben Salah') { throw 'expected full_name Ali Ben Salah' }
  if ($getOne.metadata.dept -ne 'IT') { throw 'expected metadata.dept IT' }

  $putTwo = Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT" `
    -Method Put `
    -ContentType 'application/json' `
    -Body (@{
      full_name = 'Ali Ben Salah Updated'
      metadata = @{
        dept = 'IT'
      }
    } | ConvertTo-Json -Depth 6)

  $getTwo = Invoke-RestMethod "$baseUrl/api/employees-registry/p1?company_id=DEFAULT"
  if ($getTwo.full_name -ne 'Ali Ben Salah Updated') { throw 'expected updated full_name' }

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/p2?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        employee_code = 'EMP001'
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
    if ($info.json.error -ne 'conflict') {
      throw ("expected conflict error, got {0}" -f $info.json.error)
    }
  }

  try {
    Invoke-RestMethod "$baseUrl/api/employees-registry/p3?company_id=DEFAULT" `
      -Method Put `
      -ContentType 'application/json' `
      -Body (@{
        company_id = 'OTHER'
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
    if ($info.json.error -ne 'invalid_request') {
      throw ("expected invalid_request, got {0}" -f $info.json.error)
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
