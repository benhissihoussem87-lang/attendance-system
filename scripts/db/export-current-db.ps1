$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outputDir = Join-Path $repoRoot 'backups/current-db'
$schemaPath = Join-Path $outputDir 'schema_latest.sql'
$fullPath = Join-Path $outputDir 'full_latest.sql'
$infoPath = Join-Path $outputDir 'EXPORT_INFO.md'

$envLoader = Join-Path $PSScriptRoot 'load-env.ps1'
if (Test-Path -LiteralPath $envLoader) {
  . $envLoader
}

$requiredPgVars = @('PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE')
$missingVars = @()
foreach ($name in $requiredPgVars) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    $missingVars += $name
  }
}

if ($missingVars.Count -gt 0) {
  throw ("Missing required environment variables: {0}. Set them in process/user env or in .env/.env.local and rerun." -f ($missingVars -join ', '))
}

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  throw 'pg_dump not found in PATH. Install PostgreSQL client tools and try again.'
}
$pgDumpExe = if ($pgDump.Source) { $pgDump.Source } else { $pgDump.Name }

$pgHost = $env:PGHOST
$pgPort = $env:PGPORT
$pgUser = $env:PGUSER
$pgDatabase = $env:PGDATABASE
$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

if (Test-Path -LiteralPath $schemaPath) {
  Write-Host "Replacing existing latest schema dump: $schemaPath"
  Remove-Item -LiteralPath $schemaPath -Force
}
if (Test-Path -LiteralPath $fullPath) {
  Write-Host "Replacing existing latest full dump: $fullPath"
  Remove-Item -LiteralPath $fullPath -Force
}

$schemaArgs = @(
  '--schema-only',
  '--no-owner',
  '--no-privileges',
  '--host', $pgHost,
  '--port', $pgPort,
  '--username', $pgUser,
  '--dbname', $pgDatabase,
  '--file', $schemaPath
)
$fullArgs = @(
  '--no-owner',
  '--no-privileges',
  '--host', $pgHost,
  '--port', $pgPort,
  '--username', $pgUser,
  '--dbname', $pgDatabase,
  '--file', $fullPath
)

function Invoke-PgDump {
  param(
    [string[]]$DumpArgs,
    [string]$ExpectedFile
  )
  & $pgDumpExe @DumpArgs | Out-Null
  $exitCode = $LASTEXITCODE
  $fileExists = Test-Path -LiteralPath $ExpectedFile
  $success = ($exitCode -eq 0) -and $fileExists
  return [pscustomobject]@{
    success = $success
    exitCode = $exitCode
    fileExists = $fileExists
  }
}

$schemaRun = Invoke-PgDump -DumpArgs $schemaArgs -ExpectedFile $schemaPath
$schemaSuccess = [bool]$schemaRun.success
$schemaExitCode = [int]$schemaRun.exitCode

$fullRun = Invoke-PgDump -DumpArgs $fullArgs -ExpectedFile $fullPath
$fullSuccess = [bool]$fullRun.success
$fullExitCode = [int]$fullRun.exitCode

$schemaCmdText = 'pg_dump --schema-only --no-owner --no-privileges --host "{0}" --port "{1}" --username "{2}" --dbname "{3}" --file "{4}"' -f $pgHost, $pgPort, $pgUser, $pgDatabase, $schemaPath
$fullCmdText = 'pg_dump --no-owner --no-privileges --host "{0}" --port "{1}" --username "{2}" --dbname "{3}" --file "{4}"' -f $pgHost, $pgPort, $pgUser, $pgDatabase, $fullPath
$restoreSchemaCmd = 'psql --host "{0}" --port "{1}" --username "{2}" --dbname "<target_db>" --file "{3}"' -f $pgHost, $pgPort, $pgUser, $schemaPath
$restoreFullCmd = 'psql --host "{0}" --port "{1}" --username "{2}" --dbname "<target_db>" --file "{3}"' -f $pgHost, $pgPort, $pgUser, $fullPath

$info = @(
  '# Current DB Export',
  '',
  ('- Dump timestamp: {0}' -f $timestamp),
  ('- Database name: {0}' -f $pgDatabase),
  ('- Host/port: {0}:{1}' -f $pgHost, $pgPort),
  ('- Schema dump succeeded: {0} (exit code: {1}, file exists: {2})' -f $schemaSuccess, $schemaExitCode, $schemaRun.fileExists),
  ('- Full dump succeeded: {0} (exit code: {1}, file exists: {2})' -f $fullSuccess, $fullExitCode, $fullRun.fileExists),
  '',
  '## Commands used',
  '```powershell',
  $schemaCmdText,
  $fullCmdText,
  '```',
  '',
  '## Restore commands',
  '```powershell',
  $restoreSchemaCmd,
  $restoreFullCmd,
  '```'
)

Set-Content -LiteralPath $infoPath -Value $info

if (-not $schemaSuccess -or -not $fullSuccess) {
  throw ("Export failed (schema success: {0}, full success: {1}). See {2} for details." -f $schemaSuccess, $fullSuccess, $infoPath)
}

Write-Host "Schema dump written to $schemaPath"
Write-Host "Full dump written to $fullPath"
Write-Host "Export metadata written to $infoPath"
