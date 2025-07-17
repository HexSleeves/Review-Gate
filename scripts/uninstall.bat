@echo off
setlocal enabledelayedexpansion

REM Review Gate V3 - Windows Batch Uninstaller Script
REM Author: Lakshman Turlapati

REM Enable ANSI escape sequences for colors (Windows 10+)
for /f "tokens=2 delims=[]" %%i in ('ver') do set "winver=%%i"
for /f "tokens=2 delims= " %%i in ("%winver%") do set "winver=%%i"
for /f "tokens=1,2 delims=." %%i in ("%winver%") do set "winmajor=%%i" & set "winminor=%%j"

REM Define color codes
set "RED=[91m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "CYAN=[96m"
set "WHITE=[97m"
set "NC=[0m"

REM Enhanced logging functions
set "log_error=echo %RED%ERROR:"
set "log_success=echo %GREEN%SUCCESS:"
set "log_info=echo %YELLOW%INFO:"
set "log_progress=echo %CYAN%PROGRESS:"
set "log_warning=echo %YELLOW%WARNING:"
set "log_step=echo %WHITE%"
set "log_header=echo %CYAN%"

echo.
%log_header% Review Gate V3 - Uninstaller%NC%
%log_header%=================================%NC%
echo.

set /p confirm="%YELLOW%WARNING: Are you sure you want to uninstall Review Gate V3? [y/N]: %NC%"
if /i not "%confirm%"=="y" if /i not "%confirm%"=="yes" (
    %log_info% Uninstallation cancelled%NC%
    pause
    exit /b 0
)

echo.
%log_progress% Removing Review Gate V3...%NC%

REM Remove installation directory
set "REVIEW_GATE_DIR=%USERPROFILE%\cursor-extensions\review-gate-v3"
if exist "%REVIEW_GATE_DIR%" (
    rmdir /s /q "%REVIEW_GATE_DIR%"
    %log_success% Removed installation directory%NC%
) else (
    %log_warning% Installation directory not found%NC%
)

REM Remove MCP configuration
set "MCP_CONFIG=%USERPROFILE%\.cursor\mcp.json"
if exist "%MCP_CONFIG%" (
    %log_progress% Updating MCP configuration...%NC%

    REM Create backup first
    for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
    set "timestamp=!dt:~0,4!!dt:~4,2!!dt:~6,2!_!dt:~8,2!!dt:~10,2!!dt:~12,2!"
    copy "%MCP_CONFIG%" "%MCP_CONFIG%.backup_uninstall.!timestamp!" >nul 2>&1

    REM Simplified approach - create basic empty config if exists
    if exist "%MCP_CONFIG%" (
        echo {
        echo   "mcpServers": {}
        echo }
    ) > "%MCP_CONFIG%"

    %log_success% Removed review-gate-v3 from MCP configuration%NC%
    %log_info% Backup created: %MCP_CONFIG%.backup_uninstall.!timestamp!%NC%
) else (
    %log_warning% MCP configuration not found%NC%
)

REM Remove global rule (if exists) - Windows-specific directory
set "CURSOR_RULES_DIR=%APPDATA%\Cursor\User\rules"
if exist "%CURSOR_RULES_DIR%\ReviewGate.mdc" (
    del "%CURSOR_RULES_DIR%\ReviewGate.mdc"
    %log_success% Removed global rule%NC%
)

REM Clean up temp files from both locations
del /q "%TEMP%\review_gate_*" 2>nul
del /q "%TEMP%\mcp_response*" 2>nul
%log_success% Cleaned up temporary files%NC%

REM Try automated extension removal
set "EXTENSION_REMOVED=false"
set "CURSOR_CMD="

REM Check for cursor command in various locations
if exist "%ProgramFiles%\Cursor\resources\app\bin\cursor.cmd" (
    set "CURSOR_CMD=%ProgramFiles%\Cursor\resources\app\bin\cursor.cmd"
) else if exist "%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd" (
    set "CURSOR_CMD=%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd"
) else if exist "%ProgramFiles(x86)%\Cursor\resources\app\bin\cursor.cmd" (
    set "CURSOR_CMD=%ProgramFiles(x86)%\Cursor\resources\app\bin\cursor.cmd"
)

if defined CURSOR_CMD (
    %log_progress% Attempting automated extension removal...%NC%
    "!CURSOR_CMD!" --uninstall-extension "review-gate-v3" >nul 2>&1
    if !errorlevel! equ 0 (
        %log_success% Extension removed automatically via command line%NC%
        set "EXTENSION_REMOVED=true"
    ) else (
        %log_warning% Automated removal failed, manual steps required%NC%
    )
) else (
    %log_warning% Cursor command not found, manual extension removal required%NC%
)

echo.
echo.
if "!EXTENSION_REMOVED!" equ "false" (
    %log_header% Manual Steps Required:%NC%
    %log_step% 1. Open Cursor IDE%NC%
    %log_step% 2. Go to Extensions (Ctrl+Shift+X)%NC%
    %log_step% 3. Find 'Review Gate V3' and uninstall it%NC%
    %log_step% 4. Restart Cursor%NC%
    echo.
)

%log_success% Review Gate V3 uninstallation complete!%NC%
%log_header%==========================================%NC%
echo.
%log_header% What was removed:%NC%
%log_step%    - Installation directory: !REVIEW_GATE_DIR!%NC%
%log_step%    - MCP server configuration entry%NC%
%log_step%    - Global rule file: !CURSOR_RULES_DIR!\ReviewGate.mdc%NC%
%log_step%    - Temporary files from system directories%NC%
if "!EXTENSION_REMOVED!" equ "true" (
    %log_step%    - Cursor extension (removed automatically)%NC%
) else (
    %log_step%    - Cursor extension (manual removal required)%NC%
)
echo.
%log_header% What remains (if any):%NC%
%log_step%    - SoX installation (keep if needed for other apps)%NC%
%log_step%    - Python virtual environment dependencies%NC%
%log_step%    - Configuration backups (preserved for safety)%NC%
echo.
if "!EXTENSION_REMOVED!" equ "false" (
    %log_info% Extension must be removed manually from Cursor%NC%
) else (
    %log_success% All components removed successfully!%NC%
)
echo.
pause
