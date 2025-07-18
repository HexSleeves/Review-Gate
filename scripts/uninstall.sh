#!/bin/bash

# Review Gate V3 - Uninstaller Script
# Author: Lakshman Turlapati
# This script safely removes Review Gate V3 from your system

set -euo pipefail # Exit on any error, undefined variables, or pipe failures
IFS=$'\n\t'       # Set safe Internal Field Separator

# Script version and metadata
readonly SCRIPT_VERSION="1.0.0"
readonly BACKUP_SUFFIX=".backup.$(date +%Y%m%d_%H%M%S)"

# Enhanced colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
WHITE='\033[1;37m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Enhanced logging functions
log_error() { echo -e "${RED}ERROR: $1${NC}"; }
log_success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }
log_info() { echo -e "${YELLOW}INFO: $1${NC}"; }
log_progress() { echo -e "${CYAN}PROGRESS: $1${NC}"; }
log_warning() { echo -e "${YELLOW}WARNING: $1${NC}"; }
log_step() { echo -e "${WHITE}$1${NC}"; }
log_header() { echo -e "${BLUE}$1${NC}"; }

# Detect operating system
detect_os() {
    case "$(uname)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *)
        log_error "Unsupported operating system: $(uname)"
        log_info "This script supports macOS and Linux only"
        return 1
        ;;
    esac
}

readonly OS="$(detect_os)"

log_header "Review Gate V3 - Uninstaller v$SCRIPT_VERSION"
log_header "============================================="
echo ""

# Enhanced confirmation with safety warning
confirm_uninstall() {
    echo -e "${YELLOW}WARNING: This will remove Review Gate V3 and all its components from your system.${NC}"
    echo -e "${YELLOW}The following will be removed:${NC}"
    log_step "   - Installation directory and all files"
    log_step "   - MCP server configuration"
    log_step "   - Global rules and settings"
    log_step "   - Temporary files"
    log_step "   - Cursor extension (if possible)"
    echo ""

    read -p "$(echo -e "${RED}Are you sure you want to continue? [y/N]: ${NC}")" -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Uninstallation cancelled by user"
        exit 0
    fi

    log_success "Proceeding with uninstallation..."
}

confirm_uninstall

# Enhanced installation directory removal
remove_installation_directory() {
    local review_gate_dir="$HOME/cursor-extensions/review-gate-v3"

    log_progress "Removing installation directory..."

    if [[ ! -d "$review_gate_dir" ]]; then
        log_info "Installation directory not found: $review_gate_dir"
        return 0
    fi

    # Check if directory is writable
    if [[ ! -w "$review_gate_dir" ]]; then
        log_error "Cannot remove installation directory: Permission denied"
        log_info "Try running with appropriate permissions"
        return 1
    fi

    # Safe removal with verification
    if rm -rf "$review_gate_dir"; then
        if [[ ! -d "$review_gate_dir" ]]; then
            log_success "Installation directory removed successfully"
        else
            log_error "Failed to completely remove installation directory"
            return 1
        fi
    else
        log_error "Failed to remove installation directory"
        return 1
    fi
}

remove_installation_directory

# Enhanced MCP configuration removal
remove_mcp_configuration() {
    local cursor_mcp_file="$HOME/.cursor/mcp.json"

    log_progress "Removing MCP configuration..."

    if [[ ! -f "$cursor_mcp_file" ]]; then
        log_info "MCP configuration file not found"
        return 0
    fi

    # Validate JSON before processing
    if ! python3 -c "import json; json.load(open('$cursor_mcp_file'))" >/dev/null 2>&1; then
        log_warning "MCP configuration appears to be invalid JSON"
        log_info "Creating backup and removing file"
        local backup_file="${cursor_mcp_file}${BACKUP_SUFFIX}"
        if cp "$cursor_mcp_file" "$backup_file"; then
            log_success "Backup created: $backup_file"
        fi
        rm -f "$cursor_mcp_file"
        return 0
    fi

    # Create backup
    local backup_file="${cursor_mcp_file}${BACKUP_SUFFIX}"
    if ! cp "$cursor_mcp_file" "$backup_file"; then
        log_error "Failed to create backup of MCP configuration"
        return 1
    fi

    log_success "Backup created: $backup_file"

    # Remove only the review-gate-v3 entry using Python
    if python3 <<EOF; then
import json
import sys

try:
    with open('$cursor_mcp_file', 'r') as f:
        config = json.load(f)

    # Remove review-gate-v3 from mcpServers if it exists
    servers = config.get('mcpServers', {})
    removed = servers.pop('review-gate-v3', None)

    # Write back the modified configuration
    with open('$cursor_mcp_file', 'w') as f:
        json.dump(config, f, indent=2)

    if removed:
        print("review-gate-v3 entry removed from MCP configuration")
    else:
        print("review-gate-v3 entry not found in MCP configuration")

except Exception as e:
    print(f"Error processing MCP configuration: {e}", file=sys.stderr)
    sys.exit(1)
EOF
        log_success "MCP configuration updated successfully"
    else
        log_error "Failed to update MCP configuration"
        log_info "Restoring from backup..."
        if cp "$backup_file" "$cursor_mcp_file"; then
            log_success "Configuration restored from backup"
        fi
        return 1
    fi
}

remove_mcp_configuration

# Enhanced global rule removal
remove_global_rule() {
    local cursor_rules_dir

    case "$OS" in
    macos)
        cursor_rules_dir="$HOME/Library/Application Support/Cursor/User/rules"
        ;;
    linux)
        cursor_rules_dir="$HOME/.config/Cursor/User/rules"
        ;;
    *)
        log_warning "Could not determine Cursor rules directory for platform: $OS"
        return 1
        ;;
    esac

    log_progress "Removing global rule..."

    local rule_file="$cursor_rules_dir/ReviewGate.mdc"

    if [[ ! -f "$rule_file" ]]; then
        log_info "Global rule file not found: $rule_file"
        return 0
    fi

    # Create backup before removal
    local backup_file="${rule_file}${BACKUP_SUFFIX}"
    if cp "$rule_file" "$backup_file"; then
        log_success "Global rule backed up: $backup_file"
    fi

    if rm "$rule_file"; then
        log_success "Global rule removed successfully"
    else
        log_error "Failed to remove global rule"
        return 1
    fi
}

remove_global_rule

# Enhanced temporary file cleanup
cleanup_temp_files() {
    log_progress "Cleaning up temporary files..."

    local temp_dir
    local cleaned_files=0

    # Get system temp directory safely
    if command -v python3 >/dev/null 2>&1; then
        temp_dir=$(python3 -c 'import tempfile; print(tempfile.gettempdir())' 2>/dev/null || echo "/tmp")
    else
        temp_dir="/tmp"
    fi

    # Clean up known temporary file patterns
    local patterns=("review_gate_*" "mcp_response*" "sox_test_*")

    for pattern in "${patterns[@]}"; do
        # Clean from /tmp (legacy location)
        if files=$(find "/tmp" -name "$pattern" -type f 2>/dev/null); then
            if [[ -n "$files" ]]; then
                echo "$files" | xargs rm -f 2>/dev/null || true
                cleaned_files=$((cleaned_files + $(echo "$files" | wc -l)))
            fi
        fi

        # Clean from system temp directory
        if [[ "$temp_dir" != "/tmp" ]]; then
            if files=$(find "$temp_dir" -name "$pattern" -type f 2>/dev/null); then
                if [[ -n "$files" ]]; then
                    echo "$files" | xargs rm -f 2>/dev/null || true
                    cleaned_files=$((cleaned_files + $(echo "$files" | wc -l)))
                fi
            fi
        fi
    done

    if [[ $cleaned_files -gt 0 ]]; then
        log_success "Cleaned up $cleaned_files temporary files"
    else
        log_info "No temporary files found to clean up"
    fi
}

cleanup_temp_files

# Enhanced Cursor extension removal
remove_cursor_extension() {
    log_progress "Attempting to remove Cursor extension..."

    # Try multiple extension identifiers that might be used
    local extension_ids=("review-gate-v3" "review-gate" "ReviewGate")
    local extension_removed=false

    if ! command -v cursor &>/dev/null; then
        log_info "Cursor command not found in PATH"
        log_info "Extension must be removed manually from Cursor IDE"
        return 1
    fi

    # Try to remove extension with different possible IDs
    for ext_id in "${extension_ids[@]}"; do
        log_progress "Trying to remove extension: $ext_id"
        if cursor --uninstall-extension "$ext_id" >/dev/null 2>&1; then
            log_success "Extension '$ext_id' removed automatically"
            extension_removed=true
            break
        fi
    done

    if [[ "$extension_removed" == true ]]; then
        return 0
    else
        log_warning "Automated extension removal failed for all known identifiers"
        log_info "Manual removal from Cursor IDE will be required"
        return 1
    fi
}

# Track extension removal status
EXTENSION_REMOVED=false
if remove_cursor_extension; then
    EXTENSION_REMOVED=true
fi

# Show manual removal instructions if needed
show_manual_removal_instructions() {
    if [[ "$EXTENSION_REMOVED" == false ]]; then
        echo ""
        log_header "Manual Extension Removal Required:"
        log_step "1. Open Cursor IDE"
        case "$OS" in
        macos)
            log_step "2. Press Cmd+Shift+X to open Extensions"
            ;;
        linux)
            log_step "2. Press Ctrl+Shift+X to open Extensions"
            ;;
        esac
        log_step "3. Search for 'Review Gate' or 'review-gate'"
        log_step "4. Click the gear icon and select 'Uninstall'"
        log_step "5. Restart Cursor IDE when prompted"
        echo ""
    fi
}

show_manual_removal_instructions

# Comprehensive final summary
show_final_summary() {
    echo ""
    log_success "Review Gate V3 uninstallation complete!"
    log_header "========================================="
    echo ""

    log_header "Components Removed:"
    log_step "   ✓ Installation directory: $HOME/cursor-extensions/review-gate-v3"
    log_step "   ✓ MCP server configuration entry"

    case "$OS" in
    macos)
        local rules_dir="$HOME/Library/Application Support/Cursor/User/rules"
        ;;
    linux)
        local rules_dir="$HOME/.config/Cursor/User/rules"
        ;;
    esac

    log_step "   ✓ Global rule file: $rules_dir/ReviewGate.mdc"
    log_step "   ✓ Temporary files from system directories"

    if [[ "$EXTENSION_REMOVED" == true ]]; then
        log_step "   ✓ Cursor extension (removed automatically)"
    else
        log_step "   ⚠ Cursor extension (manual removal required)"
    fi

    echo ""
    log_header "What Remains (Preserved for Safety):"
    log_step "   - SoX installation (may be needed by other applications)"
    log_step "   - Python installation and system packages"
    log_step "   - Configuration backups (created during removal)"

    echo ""
    if [[ "$EXTENSION_REMOVED" == false ]]; then
        log_warning "Manual extension removal required in Cursor IDE"
        log_info "Follow the manual steps shown above"
    else
        log_success "All components removed successfully!"
        log_info "Review Gate V3 has been completely uninstalled"
    fi

    echo ""
    log_header "Next Steps:"
    log_step "   1. Restart Cursor IDE to ensure all changes take effect"
    log_step "   2. Review any backup files if you need to restore settings"
    log_step "   3. Remove backup files when no longer needed"
}

show_final_summary
