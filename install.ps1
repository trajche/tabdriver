# Install tabdriver on Windows and register it with your browsers.
#
#   irm https://raw.githubusercontent.com/trajche/tabdriver/main/install.ps1 | iex
#
# $env:TABDRIVER_INSTALL_DIR overrides the install folder (default %LOCALAPPDATA%\Programs\tabdriver),
# $env:TABDRIVER_VERSION picks a release tag (default: latest).
$ErrorActionPreference = 'Stop'

$repo = 'trajche/tabdriver'
$dir = if ($env:TABDRIVER_INSTALL_DIR) { $env:TABDRIVER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\tabdriver' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$asset = "tabdriver_windows_$arch.zip"
$url = if ($env:TABDRIVER_VERSION) {
  "https://github.com/$repo/releases/download/$($env:TABDRIVER_VERSION)/$asset"
} else {
  "https://github.com/$repo/releases/latest/download/$asset"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item -Path (Join-Path $tmp 'tabdriver.exe') -Destination $dir -Force
} finally {
  Remove-Item -Recurse -Force $tmp
}
$exe = Join-Path $dir 'tabdriver.exe'
Write-Host "Installed $exe`n"

& $exe install

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  $newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "`nAdded $dir to your PATH. Open a new terminal to use 'tabdriver'."
}
Write-Host "`nNext: install the browser extension and add tabdriver to your agent. Run 'tabdriver' for the exact lines."
