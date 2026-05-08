param(
  [string]$BaseUrl = '',
  [string]$CompanyId = '',
  [string]$ApiKey = ''
)

$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) {
  $BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
}
if (-not $CompanyId) {
  $CompanyId = if ($env:COMPANY_ID) { $env:COMPANY_ID } else { 'DEMO' }
}
if (-not $ApiKey) {
  if ($env:API_KEY) {
    $ApiKey = $env:API_KEY
  } elseif ($env:TEST_API_KEY_OPERATOR) {
    $ApiKey = $env:TEST_API_KEY_OPERATOR
  } elseif ($env:TEST_API_KEY_ADMIN) {
    $ApiKey = $env:TEST_API_KEY_ADMIN
  } else {
    $ApiKey = ''
  }
}

function Normalize-BaseUrl([string]$value) {
  return ($value.Trim()).TrimEnd('/')
}

function Write-Section([string]$title) {
  Write-Host ''
  Write-Host ('==== ' + $title + ' ====')
}

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

function Build-QueryString([hashtable]$query) {
  if (-not $query -or $query.Count -eq 0) {
    return ''
  }
  $parts = @()
  foreach ($key in $query.Keys) {
    $value = $query[$key]
    if ($null -eq $value) {
      continue
    }
    $text = $value.ToString().Trim()
    if (-not $text) {
      continue
    }
    $parts += ([uri]::EscapeDataString($key) + '=' + [uri]::EscapeDataString($text))
  }
  if ($parts.Count -eq 0) {
    return ''
  }
  return ('?' + ($parts -join '&'))
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

function Invoke-ApiJson {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Query = $null,
    [object]$Body = $null,
    [hashtable]$Headers = $null
  )

  $queryString = Build-QueryString $Query
  $url = (Normalize-BaseUrl $BaseUrl) + $Path + $queryString

  $params = @{
    Method             = $Method
    Uri                = $url
    TimeoutSec         = 30
    StatusCodeVariable = 'statusCode'
    ErrorAction        = 'Stop'
  }
  if ($Headers -and $Headers.Count -gt 0) {
    $params['Headers'] = $Headers
  }
  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = ($Body | ConvertTo-Json -Depth 10)
  }

  try {
    $statusCode = $null
    $response = Invoke-RestMethod @params
    return @{
      status = [int]$statusCode
      body   = $response
    }
  } catch {
    $info = Get-HttpErrorInfo $_
    if ($info.json) {
      $code = if ($info.json.code) { $info.json.code } else { '-' }
      $kind = if ($info.json.details -and $info.json.details.kind) { $info.json.details.kind } else { '-' }
      $error = if ($info.json.details -and $info.json.details.error) { $info.json.details.error } else { '-' }
      throw ("{0} {1} failed (HTTP {2}, code={3}, kind={4}, error={5})" -f $Method, $url, $info.status, $code, $kind, $error)
    }
    throw ("{0} {1} failed (HTTP {2}): {3}" -f $Method, $url, $info.status, $info.text)
  }
}

function Assert-Status {
  param(
    [int]$Actual,
    [int[]]$Allowed,
    [string]$Label
  )
  if ($Allowed -notcontains $Actual) {
    throw ("{0}: expected HTTP {1}, got {2}" -f $Label, ($Allowed -join '/'), $Actual)
  }
}

$headers = @{}
if ($ApiKey -and $ApiKey.ToString().Trim()) {
  $headers['x-api-key'] = $ApiKey.ToString().Trim()
}
if ((To-Bool $env:REQUIRE_AUTH) -and -not $headers.ContainsKey('x-api-key')) {
  Write-Host 'DEMO FAIL'
  Write-Host 'REQUIRE_AUTH=1 but API_KEY is missing. Set API_KEY (or pass -ApiKey).'
  exit 1
}

Write-Section 'Demo Context'
Write-Host ("BASE_URL={0}" -f (Normalize-BaseUrl $BaseUrl))
Write-Host ("COMPANY_ID={0}" -f $CompanyId)
Write-Host ("API_KEY={0}" -f ($(if ($headers.ContainsKey('x-api-key')) { 'provided' } else { 'not provided' })))

$runId = if ($env:CI_RUN_ID) { $env:CI_RUN_ID.ToString().Trim() } else { '' }
if (-not $runId) {
  $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 10)
}
$safeRunId = ($runId -replace '[^A-Za-z0-9]', '')
if (-not $safeRunId) {
  $safeRunId = ([guid]::NewGuid().ToString('N')).Substring(0, 10)
}
$suffix = $safeRunId.ToLower()

$employees = @(
  @{
    person_id = ("demo_person_1_" + $suffix)
    employee_code = ("DEMO_EMP_1_" + $suffix)
    full_name = 'Demo Person 1'
    badge = ("DEMO-BADGE-1-" + $suffix)
  },
  @{
    person_id = ("demo_person_2_" + $suffix)
    employee_code = ("DEMO_EMP_2_" + $suffix)
    full_name = 'Demo Person 2'
    badge = ("DEMO-BADGE-2-" + $suffix)
  }
)

$deviceUid = ("DEMO-DEVICE-1-" + $suffix)

try {
  Write-Section 'Upsert Employees'
  foreach ($employee in $employees) {
    $result = Invoke-ApiJson `
      -Method 'PUT' `
      -Path ("/api/employees-registry/{0}" -f [uri]::EscapeDataString($employee.person_id)) `
      -Query @{ company_id = $CompanyId } `
      -Headers $headers `
      -Body @{
        employee_code = $employee.employee_code
        full_name = $employee.full_name
        active = $true
        metadata = @{ source = 'demo_script' }
      }
    Assert-Status -Actual $result.status -Allowed @(200) -Label ("employee upsert {0}" -f $employee.person_id)
    Write-Host ("OK employee {0} (company_id={1})" -f $employee.person_id, $CompanyId)
  }

  Write-Section 'Upsert Identity Mapping'
  foreach ($employee in $employees) {
    $result = Invoke-ApiJson `
      -Method 'PUT' `
      -Path '/api/identity-mappings' `
      -Query @{ company_id = $CompanyId } `
      -Headers $headers `
      -Body @{
        provider = 'demo'
        identifier_type = 'badge'
        identifier_value = $employee.badge
        person_id = $employee.person_id
        active = $true
        metadata = @{ source = 'demo_script' }
      }
    Assert-Status -Actual $result.status -Allowed @(200) -Label ("identity mapping upsert {0}" -f $employee.badge)
    Write-Host ("OK mapping {0} -> {1}" -f $employee.badge, $employee.person_id)
  }

  Write-Section 'Upsert Device'
  $deviceRes = Invoke-ApiJson `
    -Method 'PUT' `
    -Path ("/api/devices/{0}" -f [uri]::EscapeDataString($deviceUid)) `
    -Query @{ company_id = $CompanyId } `
    -Headers $headers `
    -Body @{
      provider = 'demo'
      device_name = 'Demo Device'
      active = $true
      metadata = @{ source = 'demo_script' }
    }
  Assert-Status -Actual $deviceRes.status -Allowed @(200) -Label 'device upsert'
  Write-Host ("OK device {0}" -f $deviceUid)

  Write-Section 'Insert Device Events (Last 3 Days)'
  $personId = $employees[0].person_id
  $identifierValue = $employees[0].badge
  $nowUtc = (Get-Date).ToUniversalTime()
  for ($offset = 2; $offset -ge 0; $offset--) {
    $workDateUtc = $nowUtc.Date.AddDays(-$offset)
    $inTime = $workDateUtc.AddHours(8).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $outTime = $workDateUtc.AddHours(17).ToString('yyyy-MM-ddTHH:mm:ssZ')

    foreach ($event in @(
      @{ direction = 'IN'; event_time_utc = $inTime },
      @{ direction = 'OUT'; event_time_utc = $outTime }
    )) {
      $eventRes = Invoke-ApiJson `
        -Method 'POST' `
        -Path '/api/device-events' `
        -Headers $headers `
        -Body @{
          company_id = $CompanyId
          person_id = $personId
          event_time_utc = $event.event_time_utc
          direction = $event.direction
          vendor = 'demo'
          device_uid = $deviceUid
          provider = 'demo'
          identifier_type = 'badge'
          identifier_value = $identifierValue
          raw_payload = @{
            source = 'demo_script'
            work_date = $workDateUtc.ToString('yyyy-MM-dd')
          }
        }
      Assert-Status -Actual $eventRes.status -Allowed @(200, 201) -Label ("device event {0} {1}" -f $workDateUtc.ToString('yyyy-MM-dd'), $event.direction)
    }
    Write-Host ("OK events for {0}" -f $workDateUtc.ToString('yyyy-MM-dd'))
  }

  Write-Section 'Attendance Summary (Last 3 Days)'
  $rows = @()
  for ($offset = 2; $offset -ge 0; $offset--) {
    $workDate = $nowUtc.Date.AddDays(-$offset).ToString('yyyy-MM-dd')
    $attendanceRes = Invoke-ApiJson `
      -Method 'GET' `
      -Path '/api/attendance' `
      -Query @{
        company_id = $CompanyId
        person_id = $personId
        date = $workDate
      } `
      -Headers $headers
    Assert-Status -Actual $attendanceRes.status -Allowed @(200) -Label ("attendance {0}" -f $workDate)

    $item = $null
    if ($attendanceRes.body -is [System.Array] -and $attendanceRes.body.Count -gt 0) {
      $item = $attendanceRes.body[0]
    } else {
      throw ("attendance {0}: expected non-empty array response" -f $workDate)
    }

    $statusValue = if ($item.effective -and $item.effective.status) { $item.effective.status } else { $item.status }
    $lateMinutes = if ($item.computed -and $item.computed.metrics) { $item.computed.metrics.late_minutes } else { $item.late_minutes }
    $sourceValue = if ($item.effective -and $item.effective.source) { $item.effective.source } else { $item.source }

    $rows += [pscustomobject]@{
      date         = $workDate
      status       = $statusValue
      first_in     = $item.first_in
      last_out     = $item.last_out
      minutes_late = $lateMinutes
      source       = $sourceValue
    }
  }

  $rows | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host ("Effective company_id={0}" -f $CompanyId)
  Write-Host 'DEMO PASS'
} catch {
  Write-Host 'DEMO FAIL'
  Write-Host $_
  exit 1
}
