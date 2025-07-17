@echo off
setlocal enabledelayedexpansion

REM Review Gate V2 - Windows Batch Installation Script
REM Author: Lakshman Turlapati
REM This script installs Review Gate V2 globally for Cursor IDE on Windows

REM Enable ANSI escape sequences for colors
for /f "tokens=2 delims=[]" %%i in ('ver') do set "winver=%%i"
for /f "tokens=2 delims= " %%i in ("%winver%") do set "winver=%%i"
for /f "tokens=1,2 delims=." %%i in ("%winver%") do set "winmajor=%%i" & set "winminor=%%j"

REM Define color codes (works on Windows 10+)
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
%log_header% Review Gate V2 - Windows Installation%NC%
%log_header%===========================================%NC%
echo.

REM Check if running on Windows
ver | findstr /i "windows" > nul
if errorlevel 1 (
    %log_error% This script is designed for Windows only%NC%
    pause
    exit /b 1
)

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    %log_success% Running with administrator privileges%NC%
) else (
    %log_warning% Administrator privileges recommended for package installations%NC%
    %log_info% Some features may require manual installation%NC%
)

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    python3 --version >nul 2>&1
    if errorlevel 1 (
        %log_error% Python 3 is required but not installed%NC%
        %log_info% Please install Python 3 from https://python.org or Microsoft Store%NC%
        %log_info% Then run this script again%NC%
        pause
        exit /b 1
    ) else (
        set "PYTHON_CMD=python3"
    )
) else (
    set "PYTHON_CMD=python"
)

for /f "tokens=*" %%i in ('!PYTHON_CMD! --version') do set "PYTHON_VERSION=%%i"
%log_success% Python found: !PYTHON_VERSION!%NC%

REM Check if Chocolatey is installed
choco --version >nul 2>&1
if errorlevel 1 (
    %log_info% Chocolatey not found%NC%
    %log_info% For automatic SoX installation, please install Chocolatey from:%NC%
    %log_info% https://chocolatey.org/install%NC%
    %log_info% Or install SoX manually from: http://sox.sourceforge.net/%NC%
    set "CHOCO_AVAILABLE=false"
) else (
    %log_success% Chocolatey found%NC%
    set "CHOCO_AVAILABLE=true"
)

REM Install SoX for speech-to-text
%log_progress% Checking SoX installation...%NC%
sox --version >nul 2>&1
if errorlevel 1 (
    if "!CHOCO_AVAILABLE!"=="true" (
        %log_progress% Installing SoX via Chocolatey...%NC%
        choco install sox -y
        if errorlevel 1 (
            %log_warning% Failed to install SoX via Chocolatey%NC%
            %log_info% Please install SoX manually from http://sox.sourceforge.net/%NC%
        ) else (
            %log_success% SoX installed successfully%NC%
        )
    ) else (
        %log_warning% SoX not found and Chocolatey not available%NC%
        %log_info% Please install SoX manually from http://sox.sourceforge.net/%NC%
    )
) else (
    %log_success% SoX already installed%NC%
)

REM Create global Cursor extensions directory
set "CURSOR_EXTENSIONS_DIR=%USERPROFILE%\cursor-extensions"
set "REVIEW_GATE_DIR=%CURSOR_EXTENSIONS_DIR%\review-gate-v2"

%log_progress% Creating global installation directory...%NC%
if not exist "!CURSOR_EXTENSIONS_DIR!" mkdir "!CURSOR_EXTENSIONS_DIR!"
if not exist "!REVIEW_GATE_DIR!" mkdir "!REVIEW_GATE_DIR!"

REM Copy MCP server files
%log_progress% Copying MCP server files...%NC%
if exist "%SCRIPT_DIR%\review_gate_v2_mcp.py" (
    copy "%SCRIPT_DIR%\review_gate_v2_mcp.py" "!REVIEW_GATE_DIR!\" >nul
) else (
    %log_error% MCP server file not found: %SCRIPT_DIR%\review_gate_v2_mcp.py%NC%
    pause
    exit /b 1
)

if exist "%SCRIPT_DIR%\requirements_simple.txt" (
    copy "%SCRIPT_DIR%\requirements_simple.txt" "!REVIEW_GATE_DIR!\" >nul
) else (
    %log_error% Requirements file not found: %SCRIPT_DIR%\requirements_simple.txt%NC%
    pause
    exit /b 1
)

REM Create Python virtual environment
%log_progress% Creating Python virtual environment...%NC%
cd /d "!REVIEW_GATE_DIR!"
!PYTHON_CMD! -m venv venv
if errorlevel 1 (
    %log_error% Failed to create virtual environment%NC%
    pause
    exit /b 1
)

REM Activate virtual environment and install dependencies
%log_progress% Installing Python dependencies...%NC%
call "venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r requirements_simple.txt
call deactivate

%log_success% Python environment created and dependencies installed%NC%

REM Create MCP configuration
set "CURSOR_MCP_FILE=%USERPROFILE%\.cursor\mcp.json"
%log_progress% Configuring MCP servers...%NC%
if not exist "%USERPROFILE%\.cursor" mkdir "%USERPROFILE%\.cursor"

REM Backup existing MCP configuration if it exists
if exist "!CURSOR_MCP_FILE!" (
    for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
    set "timestamp=!dt:~0,4!!dt:~4,2!!dt:~6,2!_!dt:~8,2!!dt:~10,2!!dt:~12,2!"
    set "BACKUP_FILE=!CURSOR_MCP_FILE!.backup.!timestamp!"
    %log_info% Backing up existing MCP configuration to: !BACKUP_FILE!%NC%
    copy "!CURSOR_MCP_FILE!" "!BACKUP_FILE!" >nul
)

REM Create simplified MCP configuration without complex JSON parsing
%log_progress% Creating MCP configuration...%NC%

REM Create basic MCP configuration with Review Gate V2
set "PYTHON_PATH=!REVIEW_GATE_DIR!\venv\Scripts\python.exe"
set "MCP_SCRIPT_PATH=!REVIEW_GATE_DIR!\review_gate_v2_mcp.py"

REM Replace backslashes with forward slashes for JSON
set "PYTHON_PATH_JSON=!PYTHON_PATH:\=/!"
set "MCP_SCRIPT_PATH_JSON=!MCP_SCRIPT_PATH:\=/!"
set "REVIEW_GATE_DIR_JSON=!REVIEW_GATE_DIR:\=/!"

REM Create MCP configuration file directly
(
echo {
echo   "mcpServers": {
echo     "review-gate-v2": {
echo       "command": "!PYTHON_PATH_JSON!",
echo       "args": ["!MCP_SCRIPT_PATH_JSON!"],
echo       "env": {
echo         "PYTHONPATH": "!REVIEW_GATE_DIR_JSON!",
echo         "PYTHONUNBUFFERED": "1",
echo         "REVIEW_GATE_MODE": "cursor_integration"
echo       }
echo     }
echo   }
echo }
) > "!CURSOR_MCP_FILE!"

if exist "!CURSOR_MCP_FILE!" (
    %log_success% MCP configuration updated successfully%NC%
    %log_header% Total MCP servers configured: 1%NC%
    %log_step%   - review-gate-v2 (Review Gate V2)%NC%
) else (
    %log_error% Failed to create MCP configuration%NC%
    if exist "!BACKUP_FILE!" (
        %log_progress% Restoring from backup...%NC%
        copy "!BACKUP_FILE!" "!CURSOR_MCP_FILE!" >nul
        %log_success% Backup restored%NC%
    ) else (
        %log_error% No backup available, installation failed%NC%
        pause
        exit /b 1
    )
)


REM Test MCP server
%log_progress% Testing MCP server...%NC%
cd /d "!REVIEW_GATE_DIR!"
timeout /t 1 /nobreak >nul 2>&1
%log_warning% MCP server test skipped (manual verification required)%NC%

REM Install Cursor extension
set "EXTENSION_FILE=%SCRIPT_DIR%\cursor-extension\review-gate-v2-2.7.3.vsix"
if exist "!EXTENSION_FILE!" (
    %log_progress% Installing Cursor extension...%NC%
    copy "!EXTENSION_FILE!" "!REVIEW_GATE_DIR!\" >nul
    
    REM Try automated installation first
    set "EXTENSION_INSTALLED=false"
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
        %log_progress% Attempting automated extension installation...%NC%
        "!CURSOR_CMD!" --install-extension "!EXTENSION_FILE!" >nul 2>&1
        if !errorlevel! equ 0 (
            %log_success% Extension installed automatically via command line%NC%
            set "EXTENSION_INSTALLED=true"
        ) else (
            %log_warning% Automated installation failed, falling back to manual method%NC%
        )
    )
    
    REM If automated installation failed, provide manual instructions
    if "!EXTENSION_INSTALLED!" equ "false" (
        echo.
        %log_header% MANUAL EXTENSION INSTALLATION REQUIRED:%NC%
        %log_info% Please complete the extension installation manually:%NC%
        %log_step% 1. Open Cursor IDE%NC%
        %log_step% 2. Press Ctrl+Shift+P%NC%
        %log_step% 3. Type 'Extensions: Install from VSIX'%NC%
        %log_step% 4. Select: !REVIEW_GATE_DIR!\review-gate-v2-2.7.3.vsix%NC%
        %log_step% 5. Restart Cursor when prompted%NC%
        echo.
        
        REM Try to open Cursor if available
        if exist "%ProgramFiles%\Cursor\Cursor.exe" (
            %log_progress% Opening Cursor IDE...%NC%
            start "" "%ProgramFiles%\Cursor\Cursor.exe"
        ) else if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" (
            %log_progress% Opening Cursor IDE...%NC%
            start "" "%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
        ) else (
            %log_info% Please open Cursor IDE manually%NC%
        )
    )
) else (
    %log_error% Extension file not found: !EXTENSION_FILE!%NC%
    %log_info% Please ensure the extension is built in cursor-extension\ directory%NC%
    %log_info% Or install manually from the Cursor Extensions marketplace%NC%
)

REM Install global rule (optional) - Windows-specific directory
set "CURSOR_RULES_DIR=%APPDATA%\Cursor\User\rules"
if exist "%SCRIPT_DIR%\ReviewGate.mdc" (
    %log_progress% Installing global rule...%NC%
    if not exist "!CURSOR_RULES_DIR!" mkdir "!CURSOR_RULES_DIR!"
    copy "%SCRIPT_DIR%\ReviewGate.mdc" "!CURSOR_RULES_DIR!\" >nul
    %log_success% Global rule installed to: !CURSOR_RULES_DIR!%NC%
) else if exist "%SCRIPT_DIR%\ReviewGate.mdc" (
    %log_warning% Could not determine Cursor rules directory%NC%
    %log_info% Global rule available at: %SCRIPT_DIR%\ReviewGate.mdc%NC%
)

REM Clean up any existing temp files
%log_progress% Cleaning up temporary files...%NC%
for /f "tokens=*" %%i in ('!PYTHON_CMD! -c "import tempfile; print(tempfile.gettempdir())"') do set "TEMP_DIR=%%i"
del /f /q "!TEMP_DIR!\review_gate_*" >nul 2>&1
del /f /q "!TEMP_DIR!\mcp_response*" >nul 2>&1

echo.
%log_success% Review Gate V2 Installation Complete!%NC%
%log_header%==========================================%NC%
echo.
%log_header% Installation Summary:%NC%
%log_step%    - MCP Server: !REVIEW_GATE_DIR!%NC%
%log_step%    - MCP Config: !CURSOR_MCP_FILE!%NC%
%log_step%    - Extension: !REVIEW_GATE_DIR!\review-gate-v2-2.7.3.vsix%NC%
%log_step%    - Global Rule: !CURSOR_RULES_DIR!\ReviewGate.mdc%NC%
echo.
%log_header% Testing Your Installation:%NC%
%log_step% 1. Restart Cursor completely%NC%
%log_info% 2. Press Ctrl+Shift+R to test manual trigger%NC%
%log_info% 3. Or ask Cursor Agent: 'Use the review_gate_chat tool'%NC%
echo.
%log_header% Speech-to-Text Features:%NC%
%log_step%    - Click microphone icon in popup%NC%
%log_step%    - Speak clearly for 2-3 seconds%NC%
%log_step%    - Click stop to transcribe%NC%
echo.
%log_header% Image Upload Features:%NC%
%log_step%    - Click camera icon in popup%NC%
%log_step%    - Select images (PNG, JPG, etc.)%NC%
%log_step%    - Images are included in response%NC%
echo.
%log_header% Troubleshooting:%NC%
%log_info%    - Logs: type "!PYTHON_CMD! -c "import tempfile; print(tempfile.gettempdir())"\review_gate_v2.log"%NC%
%log_info%    - Test SoX: sox --version%NC%
%log_info%    - Browser Console: F12 in Cursor%NC%
echo.
%log_success% Enjoy your voice-activated Review Gate!%NC%

REM Final verification
%log_progress% Final verification...%NC%
if exist "!REVIEW_GATE_DIR!\review_gate_v2_mcp.py" (
    if exist "!CURSOR_MCP_FILE!" (
        if exist "!REVIEW_GATE_DIR!\venv" (
            %log_success% All components installed successfully%NC%
            pause
            exit /b 0
        )
    )
)

%log_error% Some components may not have installed correctly%NC%
%log_info% Please check the installation manually%NC%
pause
exit /b 1