@echo off
rem Inject the MSVC toolchain into the calling cmd process.
rem
rem Local machines always use the portable MSVC under PORTABLE_MSVC_ROOT
rem (default D:\Applications\msvc-portable\msvc), even when Visual Studio
rem Build Tools are installed or the shell is a Developer Command Prompt.
rem Only CI (the CI variable, set by GitHub Actions) may use the compiler the
rem runner already put on PATH.
rem
rem Called with `call` from build-app.bat, cargo-msvc.bat and dev.bat. No
rem setlocal: the PATH/LIB/INCLUDE changes must stay in the caller.
rem Keep this file CRLF and ASCII-only.
rem
rem Exit code 0 when cl.exe is ready, 1 otherwise.

if defined CI (
  where /q cl.exe && exit /b 0
  echo ERROR: CI is set but no cl.exe is on PATH. Run ilammy/msvc-dev-cmd first. 1>&2
  exit /b 1
)

set "MSVC_ROOT=%PORTABLE_MSVC_ROOT%"
if "%MSVC_ROOT%"=="" set "MSVC_ROOT=D:\Applications\msvc-portable\msvc"

if not exist "%MSVC_ROOT%\setup_x64.bat" (
  echo ERROR: portable MSVC not found at %MSVC_ROOT%\setup_x64.bat 1>&2
  echo        Run scripts\setup-msvc.bat, or set PORTABLE_MSVC_ROOT to the folder 1>&2
  echo        that contains setup_x64.bat. 1>&2
  exit /b 1
)

rem setup_x64.bat prepends its bin directories to PATH, so its cl.exe and
rem link.exe win over any Build Tools or Git coreutils copies further down.
call "%MSVC_ROOT%\setup_x64.bat" >nul

set "MSVC_CL="
for /f "delims=" %%C in ('where cl.exe 2^>nul') do if not defined MSVC_CL set "MSVC_CL=%%C"
if not defined MSVC_CL (
  echo ERROR: cl.exe still not found after injecting %MSVC_ROOT%. 1>&2
  exit /b 1
)
rem The first cl.exe must live under MSVC_ROOT: removing MSVC_ROOT from its path
rem only changes the string when it is a substring (the check is case-insensitive).
call set "MSVC_REST=%%MSVC_CL:%MSVC_ROOT%=%%"
if /i "%MSVC_REST%"=="%MSVC_CL%" goto foreign
set "MSVC_REST="
exit /b 0

:foreign
echo ERROR: the first cl.exe on PATH is not the portable MSVC: 1>&2
echo        %MSVC_CL% 1>&2
echo        Expected it under %MSVC_ROOT% 1>&2
exit /b 1
