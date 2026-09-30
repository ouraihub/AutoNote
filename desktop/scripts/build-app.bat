@echo off
chcp 65001 >nul
setlocal

rem Release build: verify gate + frontend + Rust + NSIS installer + portable zip.
rem
rem Keep this file CRLF and ASCII-only: cmd.exe mis-parses LF-only .bat files,
rem and OEM-code-page UTF-8 Chinese breaks parsing mid-line.
rem
rem Uses the global `pnpm`. Its version must match package.json's packageManager
rem (pnpm@12.5.1); otherwise pnpm tries to download and switch versions and can
rem hang without output on the first call.

for %%R in ("%~dp0..") do set "ROOT=%%~fR\"

where /q node || (
  echo ERROR: node not found on PATH. Tauri builds require Node.js 22.12 or newer. 1>&2
  goto fail
)
where /q pnpm || (
  echo ERROR: pnpm not found on PATH. Install pnpm 12.5.1. 1>&2
  goto fail
)

set "SRC=%ROOT%src-tauri\target\release"
set "DIST=%ROOT%dist\AutoNote"
set "INSTALLER=%ROOT%dist\installer"
set "EXE=AutoNote.exe"

echo ============================================
echo   AutoNote Desktop - release build
echo ============================================
echo.

rem ---------------------------------------------------------------------------
rem [1/6] Tauri CLI reachability
rem
rem A half-created node_modules leaves the native CLI binding missing, and
rem `tauri build` then throws a stack that looks nothing like a dependency
rem problem. `pnpm install` alone reports "up to date" in that state, so the
rem directory has to go first.
rem ---------------------------------------------------------------------------
echo [1/6] Checking the Tauri CLI...
call pnpm --dir "%ROOT%." tauri --version >nul 2>nul
if not errorlevel 1 goto tauri_ok

echo       CLI not loadable; reinstalling dependencies.
rd /s /q "%ROOT%node_modules" 2>nul
call pnpm --dir "%ROOT%." install
if errorlevel 1 (
  echo ERROR: pnpm install failed. 1>&2
  goto fail
)
call pnpm --dir "%ROOT%." tauri --version >nul 2>nul
if errorlevel 1 (
  echo ERROR: the Tauri CLI is still not loadable after pnpm install. 1>&2
  goto fail
)

:tauri_ok
echo       ok.
echo.

rem ---------------------------------------------------------------------------
rem [2/6] MSVC toolchain. Locally always the portable MSVC; in CI the runner's.
rem See msvc-env.bat.
rem ---------------------------------------------------------------------------
echo [2/6] Injecting the MSVC toolchain...
call "%ROOT%scripts\msvc-env.bat"
if errorlevel 1 goto fail
for /f "delims=" %%C in ('where cl.exe 2^>nul') do if not defined BUILD_CL set "BUILD_CL=%%C"
echo       cl.exe: %BUILD_CL%
echo.

rem ---------------------------------------------------------------------------
rem [3/6] Quality gate (svelte-check + vitest + cargo test/clippy/fmt)
rem ---------------------------------------------------------------------------
echo [3/6] Running the verify gate...
call pnpm --dir "%ROOT%." run verify
if errorlevel 1 (
  echo ERROR: verify gate failed; aborting build. 1>&2
  goto fail
)
echo.

rem ---------------------------------------------------------------------------
rem [4/6] Build. `tauri build` runs `pnpm build` itself via beforeBuildCommand.
rem ---------------------------------------------------------------------------
echo [4/6] Building the application...
rd /s /q "%SRC%\bundle" 2>nul
call pnpm --dir "%ROOT%." tauri build
if errorlevel 1 (
  echo ERROR: the build failed. 1>&2
  goto fail
)
if not exist "%SRC%\%EXE%" (
  echo ERROR: build reported success but the EXE is missing: 1>&2
  echo        %SRC%\%EXE% 1>&2
  goto fail
)
echo.

rem ---------------------------------------------------------------------------
rem [5/6] Collect into dist\
rem
rem %DIST%\data holds the packaged portable library; never delete it. The EXE is
rem overwritten only after the new build exists, so a failed build leaves the
rem last good one in place.
rem ---------------------------------------------------------------------------
echo [5/6] Collecting artifacts into dist\ ...
if not exist "%DIST%" mkdir "%DIST%"
if not exist "%INSTALLER%" mkdir "%INSTALLER%"

copy /y "%SRC%\%EXE%" "%DIST%\%EXE%" >nul
if errorlevel 1 (
  echo ERROR: failed to copy the EXE into %DIST%. 1>&2
  goto fail
)

del /q "%INSTALLER%\*-setup.exe" 2>nul
if exist "%SRC%\bundle\nsis\*-setup.exe" (
  copy /y "%SRC%\bundle\nsis\*-setup.exe" "%INSTALLER%\" >nul
) else (
  echo       NOTE: no NSIS setup found under %SRC%\bundle\nsis
)
echo.

rem ---------------------------------------------------------------------------
rem [6/6] Portable zip (Tauri has no zip target on Windows). Ships the EXE only;
rem never the local data folder.
rem ---------------------------------------------------------------------------
echo [6/6] Packing the portable zip...
for /f "tokens=3 delims= " %%V in ('findstr /r /c:"^version = " "%ROOT%src-tauri\Cargo.toml"') do set "APP_VER=%%~V"
if "%APP_VER%"=="" (
  echo ERROR: could not read the version out of src-tauri\Cargo.toml. 1>&2
  goto fail
)
set "ZIP=%INSTALLER%\AutoNote_%APP_VER%_x64-portable.zip"
del /q "%ZIP%" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$stage = Join-Path $env:TEMP ('AutoNote-zip-' + [guid]::NewGuid().ToString('N')); $payload = Join-Path $stage 'AutoNote'; New-Item -ItemType Directory -Path $payload -Force | Out-Null; Copy-Item -Path (Join-Path '%DIST%' '%EXE%') -Destination $payload -Force; Compress-Archive -Path $payload -DestinationPath '%ZIP%' -CompressionLevel Optimal -Force; Remove-Item $stage -Recurse -Force"
if errorlevel 1 (
  echo ERROR: Compress-Archive failed. 1>&2
  goto fail
)
echo.

echo ============================================
echo   Done. Artifacts:
echo ============================================
echo.
dir /b "%DIST%"
dir /b "%INSTALLER%" 2>nul
echo.
echo   Portable folder: %DIST%
echo   Smoke test:      node scripts\smoke-app.mjs
echo.
exit /b 0

:fail
echo.
exit /b 1
