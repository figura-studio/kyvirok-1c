param(
  [Parameter(Mandatory = $true)][string]$DataDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]{0,47}$')][string]$Account
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'DataDirectory must be an absolute path.' }
if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows DPAPI.' }
$policyPath = Join-Path $DataDirectory 'edo-policy.json'
$policy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Account -cnotin @($policy.PSObject.Properties.Name)) { throw 'Account is not configured in edo-policy.json.' }
Write-Host 'Enter an existing Diadoc OAuth access_token locally. Do not paste it into chat.'
Write-Host 'The token will be encrypted for this Windows user. This does not issue API access or an electronic signature.'
$secret = Read-Host -Prompt 'Diadoc access_token' -AsSecureString
try {
  if ($secret.Length -lt 1 -or $secret.Length -gt 16384) { throw 'Invalid token length.' }
  $encrypted = ConvertFrom-SecureString -SecureString $secret
  $target = Join-Path $DataDirectory ('edo-' + $Account + '.dpapi')
  [IO.File]::WriteAllText($target, $encrypted, [Text.UTF8Encoding]::new($false))
  Write-Host 'Encrypted token saved. Run diagnose_edo_connection in Codex. The API token expires and must be renewed through the operator.'
} finally { $secret.Dispose(); $encrypted = $null }
