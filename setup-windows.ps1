$ErrorActionPreference = 'Stop'
# Use the Security module shipped with this PowerShell, even when launched from another edition.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')

function Test-LanAddress([Net.IPAddress]$Address) {
  if ($Address.IsIPv4MappedToIPv6) { $Address = $Address.MapToIPv4() }
  if ([Net.IPAddress]::IsLoopback($Address)) { return $true }
  $octets = $Address.GetAddressBytes()
  if ($octets.Length -eq 16) {
    return $Address.IsIPv6LinkLocal -or (($octets[0] -band 254) -eq 252)
  }
  return $octets[0] -eq 10 -or
    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
    ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
    ($octets[0] -eq 169 -and $octets[1] -eq 254)
}

function Resolve-ODataRoot([uri]$Root) {
  if (-not $Root.IsAbsoluteUri -or $Root.Scheme -notin 'http','https' -or
      -not $Root.Host -or $Root.UserInfo -or $Root.Query -or $Root.Fragment) {
    throw 'Enter an HTTP or HTTPS service URL without credentials, query or fragment.'
  }
  if ($Root.Scheme -eq 'https') { return $Root }

  try { $addresses = [Net.Dns]::GetHostAddresses($Root.DnsSafeHost) }
  catch { throw 'Cannot resolve the 1C host. Run setup inside the company LAN or its VPN.' }
  if (-not $addresses -or ($addresses | Where-Object { -not (Test-LanAddress $_) })) {
    throw 'Plain HTTP is for private LAN addresses. Use the HTTPS URL for this host.'
  }

  # Discover an HTTP-to-HTTPS redirect before asking for the 1C credentials.
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseDefaultCredentials = $false
  $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(10)
  try {
    $probe = $Root
    for ($i = 0; $i -lt 5; $i++) {
      try { $response = $client.GetAsync($probe, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult() }
      catch { throw 'The HTTP service did not respond. Check the OData URL and company LAN or VPN.' }
      try {
        $code = [int]$response.StatusCode
        if ($code -in 301,302,303,307,308) {
          if (-not $response.Headers.Location) { throw 'The redirect has no destination.' }
          $next = [uri]::new($probe, $response.Headers.Location)
          if ($next.Host -ne $Root.Host -or $next.UserInfo -or $next.Query -or $next.Fragment -or
              $next.AbsolutePath.TrimEnd('/') -cne $Root.AbsolutePath.TrimEnd('/')) {
            throw 'The redirect changes the host or OData path. Use the final OData URL supplied by your administrator.'
          }
          if ($next.Scheme -eq 'https') { return $next }
          if ($next.Scheme -ne 'http' -or $next.Port -ne $Root.Port) { throw 'Unexpected redirect. Verify the OData URL.' }
          $probe = $next
          continue
        }
        if (-not $response.IsSuccessStatusCode -and $code -notin 401,403) {
          throw "The OData root returned HTTP $code. Check the publication URL."
        }
        Write-Warning 'This LAN uses plain HTTP. The network transport does not encrypt your 1C login, password or data.'
        return $probe
      } finally { $response.Dispose() }
    }
    throw 'Too many redirects. Check the published OData URL.'
  } finally { $client.Dispose() }
}

$dir = if ($env:ONEC_MCP_DATA_DIR) { $env:ONEC_MCP_DATA_DIR } else { Join-Path $env:APPDATA 'kyvirok-1c' }
if (-not [IO.Path]::IsPathRooted($dir)) { throw 'Use an absolute path for ONEC_MCP_DATA_DIR.' }
$aliasName = Read-Host 'Connection alias, e.g. demo'
if ($aliasName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]*$') { throw 'Use a short ASCII alias.' }
$address = Resolve-ODataRoot (Read-Host '1C OData root URL (HTTPS or HTTP on the company LAN)')
Write-Host "OData URL: $($address.AbsoluteUri)"
$login = Read-Host 'Your 1C username'
$zone = Read-Host 'IANA timezone of the 1C server [Europe/Moscow]'
if (-not $zone) { $zone = 'Europe/Moscow' }
$password = Read-Host 'Your 1C password (local Windows profile only)' -AsSecureString
if (-not $login -or $password.Length -eq 0) { throw 'Username and password are required.' }
[IO.Directory]::CreateDirectory($dir) | Out-Null
$configPath = Join-Path $dir 'config.json'
$secretPath = Join-Path $dir ($aliasName + '.dpapi')
$lock = [IO.FileStream]::new((Join-Path $dir 'setup.lock'), [IO.FileMode]::OpenOrCreate,
  [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
try {
  $config = if (Test-Path -LiteralPath $configPath) {
    [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
  } else { [pscustomobject]@{connections = [pscustomobject]@{}} }
  if ($config.connections.PSObject.Properties[$aliasName] -or (Test-Path -LiteralPath $secretPath)) {
    throw 'This alias already exists. Pick a new alias or use the existing connection.'
  }
  $config.connections | Add-Member -NotePropertyName $aliasName -NotePropertyValue @{
    baseUrl = $address.AbsoluteUri.TrimEnd('/'); login = $login; serverTimezone = $zone
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  $tempConfig = Join-Path $dir ([guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($tempConfig, ($config | ConvertTo-Json -Depth 12), $utf8)
    [IO.File]::WriteAllText($secretPath, (ConvertFrom-SecureString $password), $utf8)
    if ([IO.File]::Exists($configPath)) {
      [IO.File]::Replace($tempConfig, $configPath, [System.Management.Automation.Language.NullString]::Value)
    } else { [IO.File]::Move($tempConfig,$configPath) }
  } catch {
    if ([IO.File]::Exists($tempConfig)) { [IO.File]::Delete($tempConfig) }
    if ([IO.File]::Exists($secretPath)) { [IO.File]::Delete($secretPath) }
    throw
  }
} finally { $lock.Dispose() }
Write-Host "Saved the local connection in $dir. Restart the desktop app. Write access requires write-policy.json."
