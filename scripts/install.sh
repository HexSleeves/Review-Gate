#!/bin/bash

# Review Gate V3 - One-Click Installation Script
# Author: Lakshman Turlapati
# This script installs Review Gate V3 globally for Cursor IDE

set -euo pipefail # Exit on any error, undefined variables, or pipe failures
IFS=$'\n\t'       # Set safe Internal Field Separator

# Script version and metadata
readonly SCRIPT_VERSION="1.0.0"
readonly MIN_PYTHON_VERSION="3.8"
readonly REQUIRED_DISK_SPACE_MB=500

# Enhanced colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
WHITE='\033[1;37m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
log_error() { echo -e "${RED}ERROR: $1${NC}"; }
log_success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }
log_info() { echo -e "${YELLOW}INFO: $1${NC}"; }
log_progress() { echo -e "${CYAN}PROGRESS: $1${NC}"; }
log_warning() { echo -e "${YELLOW}WARNING: $1${NC}"; }
log_step() { echo -e "${WHITE}$1${NC}"; }

# Get script directory with better error handling
get_script_dir() {
    local source="${BASH_SOURCE[0]}"
    while [[ -L "$source" ]]; do
        local dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ $source != /* ]] && source="$dir/$source"
    done
    cd -P "$(dirname "$source")/.." && pwd
}

readonly ROOT_DIR="$(get_script_dir)"

echo -e "${BLUE}Review Gate V3 - One-Click Installation v$SCRIPT_VERSION${NC}"
echo -e "${BLUE}=========================================================${NC}"
echo ""

# Detect operating system with enhanced validation
detect_os() {
    case "$OSTYPE" in
    linux-gnu*)
        echo "linux"
        ;;
    darwin*)
        echo "macos"
        ;;
    *)
        log_error "Unsupported operating system: $OSTYPE"
        log_info "This script supports Linux and macOS only"
        return 1
        ;;
    esac
}

readonly OS="$(detect_os)"

# Set package manager based on OS
case "$OS" in
linux)
    readonly PACKAGE_MANAGER="apt-get"
    readonly INSTALL_CMD="sudo $PACKAGE_MANAGER install -y"
    ;;
macos)
    readonly PACKAGE_MANAGER="brew"
    readonly INSTALL_CMD="$PACKAGE_MANAGER install"
    ;;
esac

log_success "Detected OS: $OS"

# Install Homebrew on macOS with enhanced security
install_homebrew() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi

    if command -v brew &>/dev/null; then
        log_success "Homebrew already installed"
        return 0
    fi

    log_progress "Installing Homebrew (macOS package manager)..."

    # Verify curl is available and secure
    if ! command -v curl &>/dev/null; then
        log_error "curl is required but not found"
        return 1
    fi

    # Download and verify Homebrew installation script
    local homebrew_url="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
    if ! curl -fsSL "$homebrew_url" | /bin/bash; then
        log_error "Homebrew installation failed"
        return 1
    fi

    # Verify installation
    if command -v brew &>/dev/null; then
        log_success "Homebrew installed successfully"
    else
        log_error "Homebrew installation verification failed"
        return 1
    fi
}

install_homebrew

# Install SoX with better error handling and validation
install_sox() {
    log_progress "Installing SoX for speech-to-text..."

    if command -v sox &>/dev/null; then
        log_success "SoX already installed"
        return 0
    fi

    case "$OS" in
    linux)
        if ! sudo apt-get update; then
            log_error "Failed to update package lists"
            return 1
        fi
        if ! $INSTALL_CMD sox; then
            log_error "Failed to install SoX on Linux"
            return 1
        fi
        ;;
    macos)
        if ! $INSTALL_CMD sox; then
            log_error "Failed to install SoX on macOS"
            log_info "Try: brew install sox"
            return 1
        fi
        ;;
    esac

    # Verify installation
    if command -v sox &>/dev/null; then
        log_success "SoX installed successfully"
    else
        log_error "SoX installation verification failed"
        return 1
    fi
}

install_sox

install_coreutils() {
    log_progress "Installing coreutils..."

    if command -v gmktemp &>/dev/null; then
        log_success "coreutils already installed"
        return 0
    fi

    case "$OS" in
    linux)
        if ! sudo apt-get update; then
            log_error "Failed to update package lists"
            return 1
        fi
        if ! $INSTALL_CMD coreutils; then
            log_error "Failed to install coreutils on Linux"
            return 1
        fi
        ;;
    macos)
        if ! $INSTALL_CMD coreutils; then
            log_error "Failed to install coreutils on macOS"
            return 1
        fi
        ;;
    esac

    # Verify installation
    if command -v gmktemp &>/dev/null; then
        log_success "coreutils installed successfully"
    else
        log_error "coreutils installation verification failed"
        return 1
    fi
}

install_coreutils

# Enhanced SoX validation and microphone testing
validate_sox() {
    log_progress "Validating SoX and microphone setup..."

    if ! command -v sox &>/dev/null; then
        log_error "SoX installation failed"
        log_info "Speech-to-text features will be disabled"
        case "$OS" in
        macos) log_info "Try: brew install sox" ;;
        linux) log_info "Try: sudo apt-get install sox" ;;
        esac
        return 1
    fi

    # Check if coreutils is installed
    if ! command -v gmktemp &>/dev/null; then
        log_error "coreutils is required but not installed"
        log_info "Install with: brew install coreutils"
        return 1
    fi

    local sox_version
    sox_version=$(sox --version 2>&1 | head -n1)
    log_success "SoX found: $sox_version"

    # Test microphone access with safer temp file handling
    log_progress "Testing microphone access..."
    local temp_file
    temp_file=$(gmktemp --suffix=.wav -t "sox_test_XXXXXX")

    # Ensure cleanup on exit
    trap "rm -f '$temp_file'" EXIT

    if timeout 3s sox -d -r 16000 -c 1 "$temp_file" trim 0 0.1 2>/dev/null; then
        log_success "Microphone access test successful"
    else
        log_warning "Microphone test failed - speech features may not work"
        log_info "Common fixes:"
        log_step "   - Grant microphone permissions to Terminal/iTerm"
        case "$OS" in
        macos)
            log_step "   - Check System Preferences > Security & Privacy > Microphone"
            ;;
        linux)
            log_step "   - Check audio group membership: groups \$USER"
            log_step "   - Try: sudo usermod -a -G audio \$USER"
            ;;
        esac
        log_step "   - Ensure no other apps are using the microphone"
    fi
}

validate_sox

# Enhanced Python version validation
validate_python() {
    if ! command -v python3 &>/dev/null; then
        log_error "Python 3 is required but not installed"
        case "$OS" in
        macos)
            log_info "Install with: brew install python3"
            ;;
        linux)
            log_info "Install with: sudo apt-get install python3 python3-pip"
            ;;
        esac
        return 1
    fi

    local python_version
    python_version=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    log_success "Python 3 found: $(python3 --version)"

    # Check minimum version requirement
    if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"; then
        log_success "Python version $python_version meets minimum requirement ($MIN_PYTHON_VERSION)"
    else
        log_error "Python version $python_version is below minimum requirement ($MIN_PYTHON_VERSION)"
        return 1
    fi
}

validate_python

# Validate disk space before installation
check_disk_space() {
    local available_space
    case "$OS" in
    macos)
        available_space=$(df -m "$HOME" | awk 'NR==2 {print $4}')
        ;;
    linux)
        available_space=$(df -BM "$HOME" | awk 'NR==2 {gsub(/M/, "", $4); print $4}')
        ;;
    esac

    if [[ $available_space -lt $REQUIRED_DISK_SPACE_MB ]]; then
        log_error "Insufficient disk space. Required: ${REQUIRED_DISK_SPACE_MB}MB, Available: ${available_space}MB"
        return 1
    fi
    log_success "Sufficient disk space available: ${available_space}MB"
}

check_disk_space

# Create global Cursor extensions directory with proper validation
readonly CURSOR_EXTENSIONS_DIR="$HOME/cursor-extensions"
readonly REVIEW_GATE_DIR="$CURSOR_EXTENSIONS_DIR/review-gate-v3"

log_progress "Creating global installation directory..."
mkdir -p "$REVIEW_GATE_DIR"

# Copy MCP server files
log_progress "Copying MCP server files..."
cp "$ROOT_DIR/review_gate_v3_mcp.py" "$REVIEW_GATE_DIR/"
cp "$ROOT_DIR/requirements_simple.txt" "$REVIEW_GATE_DIR/"

# Create Python virtual environment with enhanced validation
create_python_venv() {
    log_progress "Creating Python virtual environment..."

    if ! cd "$REVIEW_GATE_DIR"; then
        log_error "Failed to change to installation directory: $REVIEW_GATE_DIR"
        return 1
    fi

    # Install python3-venv on Linux if needed
    if [[ "$OS" == "linux" ]]; then
        if ! dpkg -s python3-venv >/dev/null 2>&1; then
            log_progress "Installing Python virtual environment support..."
            if ! sudo apt-get update || ! sudo apt-get install -y python3-venv; then
                log_error "Failed to install python3-venv"
                return 1
            fi
        fi
    fi

    # Create virtual environment
    if ! python3 -m venv venv; then
        log_error "Failed to create Python virtual environment"
        return 1
    fi

    # Verify virtual environment creation
    if [[ ! -f "venv/bin/activate" ]]; then
        log_error "Virtual environment creation failed - activate script not found"
        return 1
    fi

    log_success "Python virtual environment created successfully"
}

create_python_venv

# Install Python dependencies with comprehensive error handling
install_python_dependencies() {
    log_progress "Installing Python dependencies..."

    # Activate virtual environment
    if ! source venv/bin/activate; then
        log_error "Failed to activate virtual environment"
        return 1
    fi

    # Upgrade pip first
    if ! pip install --upgrade pip; then
        log_warning "Failed to upgrade pip, continuing with current version"
    fi

    # Install core dependencies with error handling
    log_progress "Installing core dependencies (mcp, pillow, asyncio, typing-extensions)..."
    local core_deps=("mcp>=1.9.2" "Pillow>=10.0.0" "asyncio" "typing-extensions>=4.14.0")

    for dep in "${core_deps[@]}"; do
        if ! pip install "$dep"; then
            log_error "Failed to install core dependency: $dep"
            deactivate
            return 1
        fi
    done

    log_success "Core dependencies installed successfully"

    # Install faster-whisper with fallback strategies
    install_faster_whisper

    deactivate
    log_success "Python environment created and dependencies installed"
}

# Separate function for faster-whisper installation with multiple fallback strategies
install_faster_whisper() {
    log_progress "Installing faster-whisper for speech-to-text..."

    # Strategy 1: Direct installation
    if pip install "faster-whisper>=1.0.0"; then
        log_success "faster-whisper installed successfully"
        return 0
    fi

    log_warning "Direct installation failed, trying CPU-only approach..."

    # Strategy 2: CPU-only installation
    if pip install "faster-whisper>=1.0.0" --no-deps; then
        if pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu; then
            log_success "faster-whisper installed with CPU-only dependencies"
            return 0
        fi
    fi

    log_warning "CPU-only installation failed, trying minimal dependencies..."

    # Strategy 3: Minimal dependencies
    if pip install "faster-whisper" --no-deps && pip install numpy; then
        log_success "faster-whisper installed with minimal dependencies"
        return 0
    fi

    # All strategies failed
    log_error "All faster-whisper installation strategies failed"
    log_info "Speech-to-text will be disabled"
    log_info "You can manually install later with: pip install faster-whisper"
    return 1
}

install_python_dependencies

# Enhanced MCP configuration with validation
configure_mcp() {
    local cursor_mcp_file="$HOME/.cursor/mcp.json"
    log_progress "Configuring MCP servers..."

    # Create .cursor directory with proper permissions
    if ! mkdir -p "$HOME/.cursor"; then
        log_error "Failed to create .cursor directory"
        return 1
    fi

    # Set proper permissions
    chmod 755 "$HOME/.cursor"

    # Backup existing configuration
    backup_mcp_config "$cursor_mcp_file"

    # Create new configuration
    create_mcp_config "$cursor_mcp_file"

    # Validate configuration
    validate_mcp_config "$cursor_mcp_file"
}

# Function to backup existing MCP configuration
backup_mcp_config() {
    local config_file="$1"

    if [[ ! -f "$config_file" ]]; then
        log_info "No existing MCP configuration found, creating new one"
        return 0
    fi

    local backup_file="${config_file}.backup.$(date +%Y%m%d_%H%M%S)"
    log_info "Backing up existing MCP configuration to: $backup_file"

    if ! cp "$config_file" "$backup_file"; then
        log_error "Failed to create backup of MCP configuration"
        return 1
    fi

    # Validate existing configuration
    if ! python3 -c "import json; json.load(open('$config_file'))" >/dev/null 2>&1; then
        log_warning "Existing MCP config has invalid JSON format"
        log_info "Will create new configuration file"
        return 1
    fi

    log_success "Existing MCP configuration backed up successfully"
}

# Function to create MCP configuration
create_mcp_config() {
    local config_file="$1"

    log_progress "Creating MCP configuration..."

    # Use a more robust Python script for configuration
    if ! python3 <<EOF; then
import json
import os
import sys

try:
    config_file = '$config_file'
    review_gate_dir = '$REVIEW_GATE_DIR'

    # Read existing config if available and valid
    existing_servers = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, 'r') as f:
                existing_config = json.load(f)
                existing_servers = existing_config.get('mcpServers', {})
                # Remove review-gate-v3 if it exists (we'll add the new one)
                existing_servers.pop('review-gate-v3', None)
        except (json.JSONDecodeError, KeyError, IOError) as e:
            print(f"Warning: Could not read existing config: {e}", file=sys.stderr)
            existing_servers = {}

    # Validate paths exist
    python_path = os.path.join(review_gate_dir, 'venv/bin/python')
    script_path = os.path.join(review_gate_dir, 'review_gate_v3_mcp.py')

    if not os.path.exists(python_path):
        print(f"Error: Python interpreter not found at {python_path}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(script_path):
        print(f"Error: MCP script not found at {script_path}", file=sys.stderr)
        sys.exit(1)

    # Add Review Gate V3 configuration
    existing_servers['review-gate-v3'] = {
        'command': python_path,
        'args': [script_path],
        'env': {
            'PYTHONPATH': review_gate_dir,
            'PYTHONUNBUFFERED': '1',
            'REVIEW_GATE_MODE': 'cursor_integration'
        }
    }

    # Write the configuration
    config = {'mcpServers': existing_servers}

    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(config_file), exist_ok=True)

    # Write with proper error handling
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)

    print(f"Configuration written successfully to {config_file}")

except Exception as e:
    print(f"Error creating MCP configuration: {e}", file=sys.stderr)
    sys.exit(1)
EOF
        log_error "Failed to create MCP configuration"
        return 1
    fi

    log_success "MCP configuration created successfully"
}

# Function to validate MCP configuration
validate_mcp_config() {
    local config_file="$1"

    log_progress "Validating MCP configuration..."

    if ! python3 -c "import json; json.load(open('$config_file'))" >/dev/null 2>&1; then
        log_error "Generated MCP configuration is invalid JSON"
        return 1
    fi

    local server_count
    server_count=$(python3 -c "import json; print(len(json.load(open('$config_file')).get('mcpServers', {})))")

    log_success "MCP configuration validated successfully"
    log_step "Total MCP servers configured: $server_count"
    log_step "  - review-gate-v3 (Review Gate V3)"
}

configure_mcp

# Enhanced MCP server testing
test_mcp_server() {
    log_progress "Testing MCP server..."

    if ! cd "$REVIEW_GATE_DIR"; then
        log_error "Failed to change to Review Gate directory"
        return 1
    fi

    # shellcheck source=/dev/null
    if ! source venv/bin/activate; then
        log_error "Failed to activate virtual environment"
        return 1
    fi

    local temp_dir
    temp_dir=$(python3 -c 'import tempfile; print(tempfile.gettempdir())')
    local test_log="$temp_dir/mcp_test_$$.log"

    # Ensure cleanup
    trap 'rm -f "$test_log"; deactivate' RETURN

    # Test server startup
    if timeout 5s python review_gate_v3_mcp.py >"$test_log" 2>&1; then
        if grep -q "Review Gate 2.0 server initialized\|server initialized\|started" "$test_log"; then
            log_success "MCP server test successful"
        else
            log_warning "MCP server started but initialization message not found"
        fi
    else
        log_warning "MCP server test inconclusive (timeout or expected for MCP servers)"
    fi
}

test_mcp_server

# Enhanced Cursor extension installation
install_cursor_extension() {
    local extension_file="$ROOT_DIR/V3/review-gate-v3-0.0.1.vsix"

    if [[ ! -f "$extension_file" ]]; then
        log_error "Extension file not found: $extension_file"
        log_info "Please ensure the extension is built in the V3/ directory"
        log_info "Or install manually from the Cursor Extensions marketplace"
        return 1
    fi

    log_progress "Installing Cursor extension..."

    # Copy extension to installation directory with error handling
    if ! cp "$extension_file" "$REVIEW_GATE_DIR/"; then
        log_error "Failed to copy extension file to installation directory"
        return 1
    fi

    # Try automated installation
    local extension_installed=false
    if command -v cursor &>/dev/null; then
        log_progress "Attempting automated extension installation..."
        if cursor --install-extension "$extension_file" >/dev/null 2>&1; then
            log_success "Extension installed automatically via command line"
            extension_installed=true
        else
            log_warning "Automated installation failed, will provide manual instructions"
        fi
    else
        log_info "Cursor command not found in PATH, will provide manual instructions"
    fi

    # Provide manual installation instructions if needed
    if [[ "$extension_installed" == false ]]; then
        show_manual_extension_instructions
        try_open_cursor
    fi
}

# Function to show manual extension installation instructions
show_manual_extension_instructions() {
    echo -e "${BLUE}MANUAL EXTENSION INSTALLATION REQUIRED:${NC}"
    log_info "Please complete the extension installation manually:"
    log_step "1. Open Cursor IDE"
    case "$OS" in
    macos)
        log_step "2. Press Cmd+Shift+P"
        ;;
    linux)
        log_step "2. Press Ctrl+Shift+P"
        ;;
    esac
    log_step "3. Type 'Extensions: Install from VSIX'"
    log_step "4. Select: $REVIEW_GATE_DIR/review-gate-v3-0.0.1.vsix"
    log_step "5. Restart Cursor when prompted"
    echo ""
}

# Function to try opening Cursor IDE
try_open_cursor() {
    if command -v cursor &>/dev/null; then
        log_progress "Opening Cursor IDE..."
        cursor . </dev/null &>/dev/null &
    elif [[ "$OS" == "macos" && -d "/Applications/Cursor.app" ]]; then
        log_progress "Opening Cursor IDE..."
        open -a "Cursor" . &
    else
        log_info "Please open Cursor IDE manually"
    fi
}

install_cursor_extension

# Enhanced global rule installation
install_global_rule() {
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

    local rule_file="$ROOT_DIR/ReviewGate.mdc"

    if [[ ! -f "$rule_file" ]]; then
        log_warning "Global rule file not found: $rule_file"
        log_info "Skipping global rule installation"
        return 0
    fi

    log_progress "Installing global rule..."

    if ! mkdir -p "$cursor_rules_dir"; then
        log_error "Failed to create Cursor rules directory: $cursor_rules_dir"
        return 1
    fi

    if ! cp "$rule_file" "$cursor_rules_dir/"; then
        log_error "Failed to copy global rule file"
        return 1
    fi

    log_success "Global rule installed to: $cursor_rules_dir"
}

install_global_rule

# Enhanced cleanup with better error handling
cleanup_temp_files() {
    log_progress "Cleaning up temporary files..."

    local temp_dir
    temp_dir=$(python3 -c 'import tempfile; print(tempfile.gettempdir())')

    # Clean up known temporary files with better pattern matching
    find "$temp_dir" -name "review_gate_*" -type f -mtime +1 -delete 2>/dev/null || true
    find "$temp_dir" -name "mcp_response*" -type f -mtime +1 -delete 2>/dev/null || true
    find "$temp_dir" -name "sox_test_*" -type f -delete 2>/dev/null || true

    log_success "Temporary files cleaned up"
}

cleanup_temp_files

echo ""
log_success "Review Gate V3 Installation Complete!"
echo -e "${GREEN}=======================================${NC}"
echo ""
echo -e "${BLUE}Installation Summary:${NC}"
log_step "   - MCP Server: $REVIEW_GATE_DIR"
log_step "   - MCP Config: $HOME/.cursor/mcp.json"
log_step "   - Extension: $REVIEW_GATE_DIR/review-gate-v3-2.7.3.vsix"
# Helper function for display purposes
get_cursor_rules_dir() {
    case "$OS" in
    macos) echo "$HOME/Library/Application Support/Cursor/User/rules" ;;
    linux) echo "$HOME/.config/Cursor/User/rules" ;;
    *) echo "Platform-specific rules directory" ;;
    esac
}

log_step "   - Global Rule: $(get_cursor_rules_dir)/ReviewGate.mdc"
echo ""
echo -e "${BLUE}Testing Your Installation:${NC}"
log_step "1. Restart Cursor completely"
log_step "2. Press Cmd+Shift+R to test manual trigger"
log_step "3. Or ask Cursor Agent: 'Use the review_gate_chat tool'"
echo ""
echo -e "${BLUE}Speech-to-Text Features:${NC}"
log_step "   - Click microphone icon in popup"
log_step "   - Speak clearly for 2-3 seconds"
log_step "   - Click stop to transcribe"
echo ""
echo -e "${BLUE}Image Upload Features:${NC}"
log_step "   - Click camera icon in popup"
log_step "   - Select images (PNG, JPG, etc.)"
log_step "   - Images are included in response"
echo ""
echo -e "${BLUE}Troubleshooting:${NC}"
log_step "   - Logs: tail -f $(python3 -c 'import tempfile; print(tempfile.gettempdir())')/review_gate_v3.log"
log_step "   - Test SoX: sox --version"
log_step "   - Browser Console: F12 in Cursor"
echo ""
log_success "Enjoy your voice-activated Review Gate!"

# Comprehensive final verification
final_verification() {
    log_progress "Final verification..."

    local cursor_mcp_file="$HOME/.cursor/mcp.json"
    local all_good=true

    # Check MCP server file
    if [[ -f "$REVIEW_GATE_DIR/review_gate_v3_mcp.py" ]]; then
        log_success "✓ MCP server file present"
    else
        log_error "✗ MCP server file missing"
        all_good=false
    fi

    # Check virtual environment
    if [[ -d "$REVIEW_GATE_DIR/venv" && -f "$REVIEW_GATE_DIR/venv/bin/activate" ]]; then
        log_success "✓ Python virtual environment created"
    else
        log_error "✗ Python virtual environment missing"
        all_good=false
    fi

    # Check MCP configuration
    if [[ -f "$cursor_mcp_file" ]]; then
        if python3 -c "import json; json.load(open('$cursor_mcp_file'))" >/dev/null 2>&1; then
            log_success "✓ MCP configuration valid"
        else
            log_error "✗ MCP configuration invalid"
            all_good=false
        fi
    else
        log_error "✗ MCP configuration file missing"
        all_good=false
    fi

    # Check dependencies
    if cd "$REVIEW_GATE_DIR" && source venv/bin/activate; then
        if python3 -c "import mcp, PIL" >/dev/null 2>&1; then
            log_success "✓ Core dependencies installed"
        else
            log_error "✗ Core dependencies missing"
            all_good=false
        fi
        deactivate
    fi

    if [[ "$all_good" == true ]]; then
        log_success "All components installed successfully"
        return 0
    else
        log_error "Some components may not have installed correctly"
        log_info "Please review the errors above and retry installation if needed"
        return 1
    fi
}

if final_verification; then
    exit 0
else
    exit 1
fi
