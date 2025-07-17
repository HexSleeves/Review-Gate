# Review Gate V2 - Windows PowerShell Uninstallation Script
# Author: Lakshman Turlapati
# This script removes Review Gate V2 from Cursor IDE on Windows

# Enable strict error handling
$ErrorActionPreference = "Stop"

# Enhanced color logging functions
function Write-Error-Log { param([string]$Message) Write-Host "ERROR: $Message" -ForegroundColor Red }
function Write-Success-Log { param([string]$Message) Write-Host "SUCCESS: $Message" -ForegroundColor Green }
function Write-Info-Log { param([string]$Message) Write-Host "INFO: $Message" -ForegroundColor Yellow }
function Write-Progress-Log { param([string]$Message) Write-Host "PROGRESS: $Message" -ForegroundColor Cyan }
function Write-Warning-Log { param([string]$Message) Write-Host "WARNING: $Message" -ForegroundColor Yellow }
function Write-Step-Log { param([string]$Message) Write-Host "$Message" -ForegroundColor White }
function Write-Header-Log { param([string]$Message) Write-Host "$Message" -ForegroundColor Cyan }

Write-Header-Log "Review Gate V2 - Windows Uninstallation"
Write-Header-Log "======================================="
Write-Host ""

# Define paths
$CursorExtensionsDir = Join-Path $env:USERPROFILE "cursor-extensions"
$ReviewGateDir = Join-Path $CursorExtensionsDir "review-gate-v2"
$CursorMcpFile = Join-Path $env:USERPROFILE ".cursor\mcp.json"
$CursorRulesDir = Join-Path $env:APPDATA "Cursor\User\rules"

# Remove MCP server directory
if (Test-Path $ReviewGateDir) {
    Write-Progress-Log "Removing Review Gate installation directory..."
    try {
        Remove-Item $ReviewGateDir -Recurse -Force
        Write-Success-Log "Installation directory removed"
    } catch {
        Write-Error-Log "Failed to remove installation directory"
        Write-Info-Log "Please remove manually: $ReviewGateDir"
    }
} else {
    Write-Info-Log "Installation directory not found"
}

# Remove from MCP configuration
if (Test-Path $CursorMcpFile) {
    Write-Progress-Log "Removing from MCP configuration..."
    
    # Backup current config
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $BackupFile = "$CursorMcpFile.backup_before_uninstall.$timestamp"
    Copy-Item $CursorMcpFile $BackupFile -Force
    Write-Info-Log "Backup created: $BackupFile"
    
    try {
        $config = Get-Content $CursorMcpFile -Raw | ConvertFrom-Json
        if ($config.mcpServers -and $config.mcpServers.PSObject.Properties.Name -contains "review-gate-v2") {
            $config.mcpServers.PSObject.Properties.Remove("review-gate-v2")
            
            # If no servers left, create empty config
            if ($config.mcpServers.PSObject.Properties.Name.Count -eq 0) {
                $config.mcpServers = @{}
            }
            
            $config | ConvertTo-Json -Depth 10 | Set-Content $CursorMcpFile -Encoding UTF8
            Write-Success-Log "Removed from MCP configuration"
            
            $remainingCount = $config.mcpServers.PSObject.Properties.Name.Count
            Write-Header-Log "Remaining MCP servers: $remainingCount"
        } else {
            Write-Info-Log "Review Gate not found in MCP configuration"
        }
    } catch {
        Write-Error-Log "Failed to update MCP configuration"
        Write-Info-Log "Please remove manually or restore from backup"
    }
} else {
    Write-Info-Log "MCP configuration file not found"
}

# Remove global rule
$ruleFile = Join-Path $CursorRulesDir "ReviewGate.mdc"
if (Test-Path $ruleFile) {
    Write-Progress-Log "Removing global rule..."
    try {
        Remove-Item $ruleFile -Force
        Write-Success-Log "Global rule removed"
    } catch {
        Write-Error-Log "Failed to remove global rule"
        Write-Info-Log "Please remove manually: $ruleFile"
    }
} else {
    Write-Info-Log "Global rule not found"
}

# Clean up temporary files
Write-Progress-Log "Cleaning up temporary files..."
Get-ChildItem $env:TEMP -Filter "review_gate_*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $env:TEMP -Filter "mcp_response*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Success-Log "Temporary files cleaned"

# Try automated extension removal
$ExtensionRemoved = $false
$cursorPaths = @(
    "${env:ProgramFiles}\Cursor\resources\app\bin\cursor.cmd",
    "${env:LOCALAPPDATA}\Programs\cursor\resources\app\bin\cursor.cmd",
    "${env:ProgramFiles(x86)}\Cursor\resources\app\bin\cursor.cmd"
)

foreach ($cursorCmd in $cursorPaths) {
    if (Test-Path $cursorCmd) {
        Write-Progress-Log "Attempting automated extension removal..."
        try {
            & $cursorCmd --uninstall-extension "review-gate-v2" | Out-Null
            Write-Success-Log "Extension removed automatically via command line"
            $ExtensionRemoved = $true
            break
        } catch {
            Write-Warning-Log "Automated removal failed: $($_.Exception.Message)"
        }
    }
}

if (-not $ExtensionRemoved) {
    Write-Warning-Log "Automated extension removal failed, manual steps required"
}

Write-Host ""
if (-not $ExtensionRemoved) {
    Write-Header-Log "MANUAL STEPS REQUIRED:"
    Write-Step-Log "1. Open Cursor IDE"
    Write-Step-Log "2. Press Ctrl+Shift+X to open Extensions"
    Write-Step-Log "3. Search for 'Review Gate' and uninstall the extension"
    Write-Step-Log "4. Restart Cursor when prompted"
    Write-Host ""
}

Write-Success-Log "Review Gate V2 Uninstallation Complete!"
Write-Header-Log "========================================="
Write-Host ""
Write-Header-Log "What was removed:"
Write-Step-Log "   - Installation directory: $ReviewGateDir"
Write-Step-Log "   - MCP server configuration entry"
Write-Step-Log "   - Global rule file"
Write-Step-Log "   - Temporary files"
Write-Host ""
Write-Header-Log "What remains (if any):"
if (-not $ExtensionRemoved) {
    Write-Step-Log "   - Cursor extension (manual removal required)"
} else {
    Write-Step-Log "   - All extension components removed successfully!"
}
Write-Step-Log "   - SoX installation (keep if needed for other apps)"
Write-Step-Log "   - Python virtual environment dependencies"
Write-Host ""
Write-Info-Log "Configuration backups are preserved for safety"
if (-not $ExtensionRemoved) {
    Write-Info-Log "Extension must be removed manually from Cursor"
} else {
    Write-Success-Log "All components removed successfully!"
}