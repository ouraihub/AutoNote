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

set "APP_VER="
node "%ROOT%scripts\version-check.mjs"
if errorlevel 1 goto fail
for /f "delims=" %%V in ('node "%ROOT%scripts\version-check.mjs"') do set "APP_VER=%%V"
if not defined APP_VER goto fail
for /f "delims=" %%T in ('node "%ROOT%scripts\release-artifacts.mjs" target') do set "TARGET=%%T"
if not defined TARGET goto fail

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
if errorlevel 1 (
  echo ERROR: Tauri CLI unavailable. Run pnpm install --frozen-lockfile from the workspace root. 1>&2
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
for /f "delims=" %%T in ('node -p "Date.now()"') do set "BUILD_STARTED=%%T"
call pnpm --dir "%ROOT%." tauri build --target x86_64-pc-windows-msvc
if errorlevel 1 (
  echo ERROR: the build failed. 1>&2
  goto fail
)
echo [5/6] Collecting the current NSIS and portable release atomically...
node "%ROOT%scripts\release-artifacts.mjs" collect "%APP_VER%" "%BUILD_STARTED%"
if errorlevel 1 goto fail
echo [6/6] Validating current artifact hashes...
node "%ROOT%scripts\release-artifacts.mjs" verify
if errorlevel 1 goto fail
echo Interactive smoke: node scripts\smoke-app.mjs
echo Current artifacts are recorded exactly in dist\release.json.
exit /b 0

:fail
echo.
exit /b 1
