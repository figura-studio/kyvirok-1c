$ErrorActionPreference = 'Stop'
$dir = if ($env:ONEC_MCP_DATA_DIR) { $env:ONEC_MCP_DATA_DIR } else { Join-Path $env:APPDATA 'kyvirok-1c' }
if (-not [IO.Path]::IsPathRooted($dir)) { throw 'Use an absolute path for ONEC_MCP_DATA_DIR.' }
$aliasName = Read-Host 'Connection alias, e.g. demo'
if ($aliasName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]*$') { throw 'Use a short ASCII alias.' }
$address = [uri](Read-Host 'HTTPS URL of the published 1C OData root')
if (-not $address.IsAbsoluteUri -or $address.Scheme -ne 'https' -or $address.UserInfo -or $address.Query -or $address.Fragment) {
  throw 'Enter a clean HTTPS service URL without credentials, query or fragment.'
}
$login = Read-Host 'Your 1C username'
$zone = Read-Host 'IANA timezone of the 1C server [Europe/Moscow]'
if (-not $zone) { $zone = 'Europe/Moscow' }
$password = Read-Host 'Your 1C password (local Windows profile only)' -AsSecureString
if (-not $login -or $password.Length -eq 0) { throw 'Username and password are required.' }
[IO.Directory]::CreateDirectory($dir) | Out-Null
$configPath = Join-Path $dir 'config.json'
$secretPath = Join-Path $dir ($aliasName + '.dpapi')
$config = if (Test-Path -LiteralPath $configPath) {
  [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
} else { [pscustomobject]@{connections = [pscustomobject]@{}} }
if ($config.connections.PSObject.Properties[$aliasName] -or (Test-Path -LiteralPath $secretPath)) {
  throw 'This alias already exists. Pick a new alias or ask your administrator to update it.'
}
$config.connections | Add-Member -NotePropertyName $aliasName -NotePropertyValue @{
  baseUrl = $address.AbsoluteUri.TrimEnd('/'); login = $login; serverTimezone = $zone
}
$utf8 = [Text.UTF8Encoding]::new($false)
$tempConfig = Join-Path $dir ([guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText($tempConfig, ($config | ConvertTo-Json -Depth 12), $utf8)
  [IO.File]::WriteAllText($secretPath, (ConvertFrom-SecureString $password), $utf8)
  if ([IO.File]::Exists($configPath)) { [IO.File]::Replace($tempConfig,$configPath,$null) }
  else { [IO.File]::Move($tempConfig,$configPath) }
} catch {
  if ([IO.File]::Exists($tempConfig)) { [IO.File]::Delete($tempConfig) }
  throw
}
Write-Host "Saved the local connection in $dir. Restart the desktop app. Write access requires write-policy.json."
