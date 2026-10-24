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

echo ============================================
echo   AutoNote Desktop - release build
echo ============================================
echo.

rem The Node orchestrator owns version checks, verify, Tauri build, packaging,
rem artifact hashes and candidate collection. This file only owns MSVC setup.
call "%ROOT%scripts\msvc-env.bat"
if errorlevel 1 goto fail
for /f "delims=" %%C in ('where cl.exe 2^>nul') do if not defined BUILD_CL set "BUILD_CL=%%C"
echo cl.exe: %BUILD_CL%
echo.
node "%ROOT%scripts\release-build.mjs" build --platform windows
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
exit /b 1
