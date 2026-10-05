$ErrorActionPreference = 'Stop'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('AutoNote-clean-fixture-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stage 'desktop'
$outside = Join-Path $stage 'outside'
New-Item -ItemType Directory -Path "$root\scripts", $outside -Force | Out-Null
Copy-Item "$PSScriptRoot\clean.bat", "$PSScriptRoot\clean-artifacts.ps1" "$root\scripts"
$originalTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = Join-Path $stage 'custom target'
$protected = @('src-tauri\target\debug\data', 'src-tauri\target\release\data', 'src-tauri\target\x86_64-pc-windows-msvc\release\data', 'dist\data', 'dist\AutoNote\data', 'build\nested\data', 'node_modules\nested\data') | ForEach-Object { Join-Path $root $_ }
$protected += @((Join-Path $env:CARGO_TARGET_DIR 'debug\data'), (Join-Path $env:CARGO_TARGET_DIR 'release\data'), (Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc\release\data'), $outside)
$expected = @{}
foreach ($dir in $protected) {
  New-Item -ItemType Directory -Path "$dir\files" -Force | Out-Null
  foreach ($name in @('library.db','files\attachment.bin')) {
    $file = Join-Path $dir $name
    [IO.File]::WriteAllBytes($file, [Text.Encoding]::UTF8.GetBytes("sentinel-$([guid]::NewGuid())"))
    $expected[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  }
}
# A deletion entry nested below a junction must not even enumerate its target.
New-Item -ItemType Directory -Path "$outside\debug\deps" -Force | Out-Null
$outsideArtifact = "$outside\debug\deps\AutoNote.exe"
[IO.File]::WriteAllText($outsideArtifact, 'external non-data sentinel')
$expected[$outsideArtifact] = (Get-FileHash $outsideArtifact).Hash
New-Item -ItemType Junction -Path "$root\src-tauri\target\release\deps" -Target $outside -Force | Out-Null
New-Item -ItemType Junction -Path "$root\dist\installer" -Target $outside -Force | Out-Null
function Assert-Protected {
  foreach ($file in $expected.Keys) {
    if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected[$file]) { throw "Protected data changed: $file" }
  }
}
New-Item -ItemType Directory -Path "$root\src-tauri\target\release", "$root\dist" -Force | Out-Null
try {
  foreach ($flags in @('--yes', '--deep --yes', '--yes --kill')) {
    New-Item -ItemType Directory -Path "$root\src-tauri\target\debug\deps", "$root\dist\AutoNote" -Force | Out-Null
    [IO.File]::WriteAllText("$root\src-tauri\target\debug\deps\generated.lib", 'generated')
    [IO.File]::WriteAllText("$root\dist\AutoNote\AutoNote.exe", 'generated')
    & cmd /d /c "`"$root\scripts\clean.bat`" $flags"
    if ($LASTEXITCODE -ne 0) { throw "Cleanup matrix failed: $flags" }
    Assert-Protected
    if (Test-Path "$root\src-tauri\target\debug\deps\generated.lib") { throw 'Known cache was not cleaned' }
    if (Test-Path "$root\dist\AutoNote\AutoNote.exe") { throw 'Collected exe was not cleaned' }
  }
  $env:CARGO_TARGET_DIR = "$root\dist\installer"
  & "$root\scripts\clean-artifacts.ps1" -Root $root -Deep
  Assert-Protected
  # Entire target/data ancestors remain protected even when explicitly selected.
  $env:CARGO_TARGET_DIR = "$root\dist\data"
  & "$root\scripts\clean-artifacts.ps1" -Root $root -Deep
  Assert-Protected
  Write-Host 'PASS: ordinary/deep/yes/kill, custom/triple targets, nested data and junction ancestors preserve bytes'
} finally {
  $env:CARGO_TARGET_DIR = $originalTarget
  # Retain rather than recursively remove a fixture containing junctions.
  Write-Host "Fixture retained for inspection: $stage. Remove junction entries first, then this isolated fixture only."
}
