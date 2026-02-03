$ErrorActionPreference = 'Stop'

if ($env:ALLOW_RESET_DB -ne '1') {
  Write-Error 'Refusing to reset DB. Set ALLOW_RESET_DB=1 to proceed.'
  exit 1
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  Write-Error 'psql not found in PATH. Install PostgreSQL client tools and try again.'
  exit 1
}

$pgHost = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' }
$pgPort = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
$pgUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
$pgDatabase = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'attendance' }
$adminDb = if ($env:PGADMINDB) { $env:PGADMINDB } else { 'postgres' }

$baseArgs = @(
  '--host', $pgHost,
  '--port', $pgPort,
  '--username', $pgUser,
  '--dbname', $adminDb,
  '--set', 'ON_ERROR_STOP=1'
)

& $psql @baseArgs -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$pgDatabase' AND pid <> pg_backend_pid();"
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to terminate existing DB connections.'
}

& $psql @baseArgs -c "DROP DATABASE IF EXISTS \"$pgDatabase\";"
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to drop database.'
}

& $psql @baseArgs -c "CREATE DATABASE \"$pgDatabase\";"
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to create database.'
}

$applyScript = Join-Path $PSScriptRoot 'apply-migrations.ps1'
& $applyScript
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to apply migrations after reset.'
}

Write-Host "DB reset complete: $pgDatabase"
