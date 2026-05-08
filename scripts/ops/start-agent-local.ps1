[CmdletBinding()]
param(
  [string]$SaasBaseUrl = "http://127.0.0.1:3000",
  [string]$K80DeviceUid = "zkteco:sn:BIND-QUEUE-c26a7486"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($env:SAAS_BASE_URL)) {
  $env:SAAS_BASE_URL = $SaasBaseUrl
}

if ([string]::IsNullOrWhiteSpace($env:K80_RT_SUBSCRIBER_ENABLED)) {
  $env:K80_RT_SUBSCRIBER_ENABLED = "true"
}

if ([string]::IsNullOrWhiteSpace($env:K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST)) {
  $env:K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST = $K80DeviceUid
}

$diagnosticsHost = if ([string]::IsNullOrWhiteSpace($env:AGENT_DIAGNOSTICS_HOST)) { "127.0.0.1" } else { $env:AGENT_DIAGNOSTICS_HOST }
$diagnosticsPort = if ([string]::IsNullOrWhiteSpace($env:AGENT_DIAGNOSTICS_PORT)) { "4780" } else { $env:AGENT_DIAGNOSTICS_PORT }

Write-Host "Starting attendance agent in foreground for local/internal K80 mode."
Write-Host "Repository: $repoRoot"
Write-Host "SAAS_BASE_URL: $env:SAAS_BASE_URL"
Write-Host "Diagnostics URL: http://$diagnosticsHost`:$diagnosticsPort/diagnostics"
Write-Host "Diagnostics API: http://$diagnosticsHost`:$diagnosticsPort/api/local-diagnostics"
Write-Host "K80_RT_SUBSCRIBER_ENABLED: $env:K80_RT_SUBSCRIBER_ENABLED"
Write-Host "K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST: $env:K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST"
Write-Host "Known-good local K80 device UID: $K80DeviceUid"
Write-Host "Stop with Ctrl+C. This does not install a service or daemonize the agent."
Write-Host "Production note: move this policy into DB-backed device/profile/service configuration later."

& npm run agent:start
exit $LASTEXITCODE
