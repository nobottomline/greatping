param(
  [Parameter(Mandatory=$true)][string]$Candidate
)
$ErrorActionPreference = 'Stop'
$qaRoot = Join-Path ([IO.Path]::GetTempPath()) ('greatping-windows-' + [guid]::NewGuid())
try {
  $runtime = Join-Path $qaRoot 'runtime'
  $installation = Join-Path $qaRoot 'installation with spaces'
  New-Item -ItemType Directory -Force $runtime | Out-Null
  # A stable runtime path matches normal installations and survives the host's
  # versioned setup-node cache, which integrations deliberately reject.
  Copy-Item (Get-Command node.exe).Source (Join-Path $runtime 'node.exe')
  & npm.cmd install --prefix $installation --ignore-scripts --no-audit --no-fund --package-lock=false (Join-Path $Candidate 'greatping.tgz')
  if ($LASTEXITCODE -ne 0) { throw 'Archive installation failed' }
  $env:PATH = "$runtime;$env:PATH"
  $env:GREATPING_TEST_CLI = Join-Path $installation 'node_modules/greatping/dist/index.js'
  $env:GREATPING_TEST_LAUNCHER = Join-Path $installation 'node_modules/.bin/greatping.cmd'
  $env:GREATPING_TEST_PAIRING_FIXTURE = Join-Path $Candidate 'fixtures/pairing-fetch.mjs'
  $env:GREATPING_TEST_OPERATIONS_FETCH_FIXTURE = Join-Path $Candidate 'fixtures/operations-fetch.mjs'
  $env:GREATPING_TEST_ACCOUNT_FIXTURE = Join-Path $Candidate 'fixtures/account.mjs'
  & (Join-Path $runtime 'node.exe') --test apps/cli/test/platform.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Windows platform qualification failed' }
} finally {
  Remove-Item -LiteralPath $qaRoot -Recurse -Force -ErrorAction SilentlyContinue
}
