param([Parameter(Mandatory=$true)][string]$Root, [switch]$Deep)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
function Is-Protected([string]$Path) {
  for ($parent = [IO.Path]::GetFullPath($Path); $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
    if ([IO.Path]::GetFileName($parent) -ieq 'data') { return $true }
    if (Test-Path -LiteralPath $parent) {
      if (((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    }
  }
  return $false
}
function Remove-Generated([string]$Path) {
  if (Is-Protected $Path) { Write-Host "Keeping protected $Path"; return }
  if (!(Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (!$item.PSIsContainer) { Remove-Item -LiteralPath $Path -Force; return }
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Remove-Generated $child.FullName }
  if (!(Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $Path -Force }
}
$targets = @((Join-Path $Root 'src-tauri\target'))
if ($env:CARGO_TARGET_DIR) {
  $custom = $env:CARGO_TARGET_DIR
  if (![IO.Path]::IsPathRooted($custom)) { $custom = Join-Path $Root "src-tauri\$custom" }
  $targets += [IO.Path]::GetFullPath($custom)
}
foreach ($target in $targets | Select-Object -Unique) {
  $profileRoots = @($target)
  if ((Test-Path -LiteralPath $target) -and !(Is-Protected $target)) {
    # Cargo target triples are generated containers; unknown directories stay intact.
    $profileRoots += @(Get-ChildItem -LiteralPath $target -Directory -Force | Where-Object { $_.Name -match '^(x86_64|i686|aarch64|arm|wasm32|riscv64)-' } | ForEach-Object { $_.FullName })
  }
  foreach ($profileRoot in $profileRoots) {
    foreach ($profile in @('debug','release')) {
      foreach ($cache in @('.fingerprint','build','deps','examples','incremental','bundle')) { Remove-Generated (Join-Path $profileRoot "$profile\$cache") }
      foreach ($name in @('AutoNote.exe','autonote.exe','autonote.pdb','autonote.d','autonote_lib.dll','autonote_lib.lib','autonote_lib.pdb')) { Remove-Generated (Join-Path $profileRoot "$profile\$name") }
    }
  }
  foreach ($name in @('.rustc_info.json','CACHEDIR.TAG')) { Remove-Generated (Join-Path $target $name) }
}
$repo = [IO.Path]::GetDirectoryName($Root)
foreach ($name in @('dist\installer','dist\release.json','build','.svelte-kit','.tmp')) { Remove-Generated (Join-Path $Root $name) }
Remove-Generated (Join-Path $Root 'dist\AutoNote\AutoNote.exe')
# web\.wrangler keeps local D1 state; the Cloudflare login lives in the user profile, not the repo.
foreach ($name in @('web\dist','web\.svelte-kit')) { Remove-Generated (Join-Path $repo $name) }
if ($Deep) {
  # Hoisted pnpm installs into the repo root; workspaces may also have their own node_modules.
  # Dependencies hold no user data, so use rd: fast, and it removes junctions without following them.
  $modules = @('node_modules', 'desktop\node_modules', 'web\node_modules') + @(Get-ChildItem -LiteralPath (Join-Path $repo 'packages') -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { "packages\$($_.Name)\node_modules" })
  foreach ($dir in $modules) {
    $path = Join-Path $repo $dir
    if (Test-Path -LiteralPath $path) { cmd /d /c "rd /s /q `"$path`""; if (Test-Path -LiteralPath $path) { throw "Could not remove $path (files in use?)" } }
  }
}
