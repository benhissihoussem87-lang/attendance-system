param(
  [string]$DbName = 'attendance_tmp',
  [string]$PgHost = 'localhost',
  [int]$PgPort = 5432,
  [string]$PgUser = 'postgres',
  [string]$Password,
  [switch]$SkipDrop,
  [bool]$RunTests = $true
)

$ErrorActionPreference = 'Stop'

$script:SetPassword = $false
$script:SetDbName = $false
$script:SetTestEnv = $false
$script:SetPgEnv = $false
$script:FailedStep = $null

function Write-Section([string]$title) {
  Write-Host ''
  Write-Host ('==== ' + $title + ' ====')
}

function Fail-Step([string]$label, [string]$detail) {
  Write-Host ('SMOKE FAIL: ' + $label)
  if ($detail) {
    Write-Host $detail
  }
  exit 1
}

function Invoke-External([string]$label, [string]$command, [string[]]$argv) {
  Write-Host ('> ' + $command + ' ' + ($argv -join ' '))
  & $command @argv
  if ($LASTEXITCODE -ne 0) {
    Fail-Step $label ('Command failed with exit code ' + $LASTEXITCODE)
  }
}

function Invoke-Psql([string]$label, [string]$database, [string]$sql, [switch]$Quiet) {
  $psqlArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', $PgHost, '-p', $PgPort, '-U', $PgUser, '-d', $database)
  if ($Quiet) {
    $psqlArgs += @('-t', '-A')
  }
  $psqlArgs += @('-c', $sql)
  Invoke-External $label 'psql' $psqlArgs
}

function Get-ColumnSet([string]$tableName) {
  $sql = "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='$tableName' ORDER BY ordinal_position;"
  $psqlArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', $PgHost, '-p', $PgPort, '-U', $PgUser, '-d', $DbName, '-t', '-A', '-c', $sql)
  $raw = @(& psql @psqlArgs)
  if ($LASTEXITCODE -ne 0) {
    Fail-Step 'column_introspection' ('Command failed with exit code ' + $LASTEXITCODE)
  }
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($line in $raw) {
    $name = $line.Trim()
    if ($name) {
      [void]$set.Add($name)
    }
  }
  return $set
}

try {
  if ($Password) {
    $env:PGPASSWORD = $Password
    $script:SetPassword = $true
  }

  $env:PGUSER = $PgUser
  $env:PGHOST = $PgHost
  $env:PGPORT = $PgPort
  $script:SetPgEnv = $true

  Write-Host ('Using PgHost=' + $PgHost + ', PgPort=' + $PgPort + ', PgUser=' + $PgUser + ', DbName=' + $DbName)

  Write-Section 'Drop/Create Database'
  if (-not $SkipDrop) {
    Invoke-Psql 'drop_db' 'postgres' ('DROP DATABASE IF EXISTS "' + $DbName + '" WITH (FORCE);')
    Invoke-Psql 'create_db' 'postgres' ('CREATE DATABASE "' + $DbName + '";')
  } else {
    Write-Host 'SkipDrop set; leaving database as-is.'
  }

  $env:PGDATABASE = $DbName
  $script:SetDbName = $true

  Write-Section 'Apply Migrations'
  Invoke-External 'apply_migrations' '.\scripts\db\apply-migrations.ps1' @()

  Write-Section 'Preflight Identity'
  Invoke-Psql 'preflight_identity' $DbName 'SELECT current_user, inet_server_addr(), inet_server_port();'

  Write-Section 'Schema Migrations'
  $schemaCols = Get-ColumnSet 'schema_migrations'
  if ($schemaCols.Contains('filename') -and $schemaCols.Contains('applied_at')) {
    Invoke-Psql 'schema_migrations' $DbName 'SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at, filename;'
  } elseif ($schemaCols.Contains('filename')) {
    Invoke-Psql 'schema_migrations' $DbName 'SELECT filename FROM schema_migrations ORDER BY filename;'
  } else {
    Invoke-Psql 'schema_migrations' $DbName 'SELECT * FROM schema_migrations;'
  }

  Write-Section 'Bootstrap Invariants'
  $invariantSql = @'
SELECT
  (SELECT COUNT(*) FROM public.companies WHERE company_id = 'DEFAULT') AS default_company,
  (SELECT COUNT(*) FROM public.company_config WHERE company_id = 'DEFAULT') AS default_company_config,
  (SELECT COUNT(*) FROM public.company_working_days WHERE company_id = 'DEFAULT') AS default_working_days,
  (SELECT COUNT(*) FROM public.rule_sets) AS rule_sets_count,
  (SELECT COUNT(*) FROM public.policy_profiles) AS policy_profiles_count;
'@
  $psqlArgs2 = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', $PgHost, '-p', $PgPort, '-U', $PgUser, '-d', $DbName, '-t', '-A', '-c', $invariantSql)
  $raw = @(& psql @psqlArgs2)
  if ($LASTEXITCODE -ne 0) {
    Fail-Step 'invariants_query' ('Command failed with exit code ' + $LASTEXITCODE)
  }
  $line = (@($raw) | Where-Object { $_ -and $_.ToString().Trim() } | Select-Object -First 1)
  if (-not $line) {
    Fail-Step 'invariants_parse' 'No output from invariants query.'
  }
  $line = $line.ToString().Trim()
  $parts = $line -split '\|'
  if ($parts.Length -lt 5) {
    Fail-Step 'invariants_parse' ('Unexpected output: ' + $line)
  }
  $defaultCompany = [int]$parts[0]
  $defaultCompanyConfig = [int]$parts[1]
  $defaultWorkingDays = [int]$parts[2]
  $ruleSetsCount = [int]$parts[3]
  $policyProfilesCount = [int]$parts[4]

  Write-Host ('default_company=' + $defaultCompany)
  Write-Host ('default_company_config=' + $defaultCompanyConfig)
  Write-Host ('default_working_days=' + $defaultWorkingDays)
  Write-Host ('rule_sets_count=' + $ruleSetsCount)
  Write-Host ('policy_profiles_count=' + $policyProfilesCount)

  if ($defaultCompany -ne 1 -or $defaultCompanyConfig -ne 1 -or $defaultWorkingDays -ne 7 -or $ruleSetsCount -lt 1 -or $policyProfilesCount -lt 1) {
    Fail-Step 'invariants_check' 'Bootstrap invariants failed.'
  }

  Write-Section 'Schema Prints'
  Invoke-Psql 'schema_attendance_days' $DbName '\d public.attendance_days'
  Invoke-Psql 'schema_company_config' $DbName '\d public.company_config'
  Invoke-Psql 'schema_company_working_days' $DbName '\d public.company_working_days'
  Invoke-Psql 'schema_employee_leaves' $DbName '\d public.employee_leaves'

  if ($RunTests) {
    Write-Section 'Run Tests'
    $env:ALLOW_TEST_ENDPOINTS = 'true'
    $env:USE_EMPLOYEES_REGISTRY = '1'
    $env:USE_IDENTITY_MAPPINGS = '1'
    $env:REQUIRE_IDENTITY_MAPPINGS = '1'
    $env:USE_EMPLOYEE_ASSIGNMENTS = '1'
    $script:SetTestEnv = $true

    Invoke-External 'tests' '.\tests\run-all.ps1' @()
  } else {
    Write-Host 'RunTests not set; skipping tests.'
  }

  Write-Host ''
  Write-Host 'SMOKE PASS'
  exit 0
} finally {
  if ($script:SetPassword) {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
  if ($script:SetDbName) {
    Remove-Item Env:PGDATABASE -ErrorAction SilentlyContinue
  }
  if ($script:SetPgEnv) {
    Remove-Item Env:PGUSER -ErrorAction SilentlyContinue
    Remove-Item Env:PGHOST -ErrorAction SilentlyContinue
    Remove-Item Env:PGPORT -ErrorAction SilentlyContinue
  }
  if ($script:SetTestEnv) {
    Remove-Item Env:ALLOW_TEST_ENDPOINTS -ErrorAction SilentlyContinue
    Remove-Item Env:USE_EMPLOYEES_REGISTRY -ErrorAction SilentlyContinue
    Remove-Item Env:USE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
    Remove-Item Env:REQUIRE_IDENTITY_MAPPINGS -ErrorAction SilentlyContinue
    Remove-Item Env:USE_EMPLOYEE_ASSIGNMENTS -ErrorAction SilentlyContinue
  }
}
