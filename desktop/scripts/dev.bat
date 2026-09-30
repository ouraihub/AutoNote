@echo off
rem Start `tauri dev` with the portable MSVC environment injected (msvc-env.bat).
rem Keep this file CRLF and ASCII-only: cmd.exe mis-parses LF-only or UTF-8 batch files.
rem No setlocal: msvc-env.bat must keep its PATH changes for the cargo child.

for %%R in ("%~dp0..") do set "ROOT=%%~fR"

call "%~dp0msvc-env.bat" || exit /b 1

call pnpm --dir "%ROOT%" tauri dev
exit /b %ERRORLEVEL%
