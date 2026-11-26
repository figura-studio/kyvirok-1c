param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(-preview\.\d+)?$') { throw 'Invalid release version.' }
$pluginVersion = (Get-Content -LiteralPath (Join-Path $root 'plugins\kyvirok-1c\plugin.json') -Raw | ConvertFrom-Json).version
if ($pluginVersion -ne $version) { throw 'Plugin and package versions do not match.' }
# Explicit public inputs: personal settings, credentials and node_modules cannot enter the ZIP.
$inputs = @('.gitignore', '.agents', 'README.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE',
  'package.json', 'pnpm-lock.yaml', 'build.mjs', 'server.mjs', 'changes.mjs', 'policy.mjs',
  'approval.mjs', 'actions.mjs', 'bridge.mjs', 'artifacts.mjs', 'bridge-policy.example.json', 'BRIDGE.md', 'OPERATIONS.md',
  'edo.mjs', 'edo-drafts.mjs', 'edo-policy.example.json', 'EXTERNAL-EDO.md', 'AGENT-GUIDE.md', 'setup-edo-windows.ps1',
  'setup-windows.ps1', 'package-release.ps1', 'write-policy.example.json', 'plugins', 'vendor', 'test')
$files = @()
foreach ($relative in $inputs) {
  $item = Get-Item -LiteralPath (Join-Path $root $relative) -Force
  if ($item.PSIsContainer) { $files += Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force }
  else { $files += $item }
}
foreach ($file in $files) {
  if ($file.Name -match '^(config|credentials|write-policy|bridge-policy|edo-policy)\.json$|^\.env|\.(dpapi|log|tmp)$' -or
      $file.FullName -match '[\\/]node_modules[\\/]' -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Non-public input: $($file.Name)" }
}
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$archivePath = Join-Path $OutputDirectory "kyvirok-1c-$version.zip"
$temporary = Join-Path $OutputDirectory ('.release-' + [Guid]::NewGuid().ToString('N') + '.zip')
$prefix = "kyvirok-1c-$version/"
try {
  $zip = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in ($files | Sort-Object FullName)) {
      $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName,
        $prefix + $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
  $zip = [IO.Compression.ZipFile]::OpenRead($temporary)
  try {
    foreach ($required in @('write-policy.example.json', 'plugins/kyvirok-1c/server.mjs',
      'plugins/kyvirok-1c/plugin.json', '.agents/plugins/marketplace.json', 'build.mjs',
      'server.mjs', 'changes.mjs', 'policy.mjs', 'approval.mjs', 'actions.mjs', 'bridge.mjs', 'artifacts.mjs',
      'bridge-policy.example.json', 'BRIDGE.md', 'OPERATIONS.md', 'edo.mjs', 'edo-policy.example.json',
      'EXTERNAL-EDO.md', 'AGENT-GUIDE.md', 'edo-drafts.mjs', 'setup-edo-windows.ps1', 'test/edo.test.mjs', 'test/edo-drafts.test.mjs', 'test/connector.test.mjs', 'INSTALL.md')) {
      if ($null -eq $zip.GetEntry($prefix + $required)) { throw "Missing release file: $required" }
    }
  } finally { $zip.Dispose() }
  Move-Item -LiteralPath $temporary -Destination $archivePath -Force
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($archivePath)
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  [IO.File]::WriteAllText($archivePath + '.sha256', "$hash  kyvirok-1c-$version.zip`n", [Text.UTF8Encoding]::new($false))
  Write-Output $archivePath
  Write-Output "SHA256 $hash"
} finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
