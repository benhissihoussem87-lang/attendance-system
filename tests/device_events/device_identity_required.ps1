$ErrorActionPreference = 'Stop'

$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

function Get-HttpErrorInfo {
  param($err)

  $status = $null
  $text = $null

  # PowerShell 5.1 غالباً: System.Net.WebException + HttpWebResponse
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

  # PowerShell 7+ غالباً: HttpResponseException + HttpResponseMessage
  if (-not $text) {
    try {
      $resp2 = $err.Exception.Response
      if ($resp2 -and $resp2.Content) {
        $status = [int]$resp2.StatusCode
        $text = $resp2.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {}
  }

  # Fallback: أحياناً تكون الرسالة موجودة هنا
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
  # CASE 1: direct device event insert with empty device_uid => must be 400 + JSON error
  $badEvent = @{
    person_id = 'p1'
    event_time_utc = '2026-01-12T08:00:00Z'
    direction = 'IN'
    device_uid = ''
  } | ConvertTo-Json -Depth 5

  try {
    Invoke-RestMethod "$baseUrl/api/device-events" -Method Post -ContentType 'application/json' -Body $badEvent | Out-Null
    throw 'expected device-events insert to fail'
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.status -ne 400) {
      throw ("expected HTTP 400, got {0}. body={1}" -f $info.status, $info.text)
    }
    if (-not $info.json) {
      throw ("expected JSON error body. raw={0}" -f $info.text)
    }
    if ($info.json.code -ne 'VALIDATION_ERROR') {
      throw ("expected VALIDATION_ERROR, got {0}" -f $info.json.code)
    }
    if (-not $info.json.details -or $info.json.details.kind -ne 'validation') {
      throw 'expected details.kind=validation'
    }
    if ($info.json.details.error -ne 'DEVICE_ID_REQUIRED') {
      throw ("expected DEVICE_ID_REQUIRED, got {0}" -f $info.json.details.error)
    }
  }

  # CASE 2: CSV commit with empty device_uid should fail row and insert 0
  $csv = @"
person_id,event_time,direction,device_uid
p1,2026-01-12 08:00:00,IN,
"@

  $res = Invoke-RestMethod "$baseUrl/api/device-events/import/commit?company_id=DEFAULT" `
    -Method Post `
    -ContentType 'text/plain' `
    -Body $csv

  if ($res.inserted_rows -ne 0) { throw 'expected inserted_rows=0 for missing device_uid' }
  if ($res.failed_rows -lt 1)   { throw 'expected failed_rows >= 1 for missing device_uid' }

  Write-Host 'PASS: device identity required'
  exit 0
} catch {
  Write-Host 'FAIL: device identity required'
  Write-Host '---- ERROR ----'
  Write-Host $_
  exit 1
}
