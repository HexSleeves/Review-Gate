#!/bin/bash

# Review Gate V3 - One-Click Installation Script

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
WHITE='\033[1;37m'
CYAN='\033[0;36m'
NC='\033[0m'

log_error() { echo -e "${RED}ERROR: $1${NC}"; }
log_success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }
log_info() { echo -e "${YELLOW}INFO: $1${NC}"; }
log_progress() { echo -e "${CYAN}PROGRESS: $1${NC}"; }
log_warning() { echo -e "${YELLOW}WARNING: $1${NC}"; }
log_step() { echo -e "${WHITE}$1${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
CURSOR_EXTENSIONS_DIR="${HOME}/cursor-extensions"
REVIEW_GATE_DIR="${CURSOR_EXTENSIONS_DIR}/review-gate-v3"
LEGACY_REVIEW_GATE_DIR="${CURSOR_EXTENSIONS_DIR}/review-gate-v2"
CURSOR_MCP_FILE="${HOME}/.cursor/mcp.json"
CURSOR_RULES_DIR=""
VSIX_PATH=""

run_install_helper() {
  PYTHONPATH="${SCRIPT_DIR}" python3 -m review_gate_mcp.install_utils "$@"
}

find_vsix() {
  if VSIX_PATH="$(run_install_helper discover-vsix --extension-dir "${SCRIPT_DIR}/cursor-extension")"; then
    return 0
  fi
  return 1
}

echo -e "${BLUE}Review Gate V3 - One-Click Installation${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
  PACKAGE_MANAGER="apt-get"
  INSTALL_CMD="sudo ${PACKAGE_MANAGER} install -y"
  CURSOR_RULES_DIR="${HOME}/.config/Cursor/User/rules"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
  PACKAGE_MANAGER="brew"
  INSTALL_CMD="${PACKAGE_MANAGER} install"
  CURSOR_RULES_DIR="${HOME}/Library/Application Support/Cursor/User/rules"
else
  log_error "Unsupported operating system: ${OSTYPE}"
  log_info "Use manual installation on this platform."
  exit 1
fi

log_success "Detected OS: ${OS}"

if ! find_vsix; then
  log_error "No packaged Review Gate V3 VSIX was found in ${SCRIPT_DIR}/cursor-extension."
  log_info "Build the extension first from ${SCRIPT_DIR}/cursor-extension, then rerun install.sh."
  exit 1
fi

log_success "Using extension package: ${VSIX_PATH}"

if [[ "${OS}" == "macos" ]] && ! command -v brew &> /dev/null; then
  log_progress "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

log_progress "Installing system dependencies..."
if [[ "${OS}" == "linux" ]]; then
  sudo apt-get update
  ${INSTALL_CMD} sox pkg-config ffmpeg libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavdevice-dev
else
  ${INSTALL_CMD} sox pkg-config ffmpeg
fi

if command -v sox &> /dev/null; then
  log_success "SoX found: $(sox --version 2>&1 | head -n1)"
  log_progress "Testing microphone access..."
  if sox -d -r 16000 -c 1 /tmp/sox_test_$$.wav trim 0 0.1 >/dev/null 2>&1; then
    rm -f /tmp/sox_test_$$.wav
    log_success "Microphone access test successful"
  else
    rm -f /tmp/sox_test_$$.wav
    log_warning "Microphone test failed. Speech features may be unavailable until system permissions are fixed."
  fi
else
  log_warning "SoX is not installed correctly. Speech features will remain unavailable."
fi

if ! command -v python3 &> /dev/null; then
  log_error "Python 3 is required but was not found."
  exit 1
fi

log_success "Python found: $(python3 --version)"
mkdir -p "${REVIEW_GATE_DIR}"

if [[ -d "${LEGACY_REVIEW_GATE_DIR}" && "${LEGACY_REVIEW_GATE_DIR}" != "${REVIEW_GATE_DIR}" ]]; then
  log_info "Legacy install directory detected at ${LEGACY_REVIEW_GATE_DIR}. The new install will use ${REVIEW_GATE_DIR}."
fi

log_progress "Copying Review Gate files..."
rm -rf "${REVIEW_GATE_DIR}/review_gate_mcp"
cp -R "${SCRIPT_DIR}/review_gate_mcp" "${REVIEW_GATE_DIR}/"
cp "${SCRIPT_DIR}/pyproject.toml" "${REVIEW_GATE_DIR}/"
cp "${SCRIPT_DIR}/requirements.txt" "${REVIEW_GATE_DIR}/"
cp "${SCRIPT_DIR}/readme.md" "${REVIEW_GATE_DIR}/"
cp "${VSIX_PATH}" "${REVIEW_GATE_DIR}/"

cd "${REVIEW_GATE_DIR}"

if [[ "${OS}" == "linux" ]] && ! dpkg -s python3-venv >/dev/null 2>&1; then
  log_progress "Installing python3-venv..."
  sudo apt-get update
  sudo apt-get install -y python3-venv
fi

log_progress "Creating Python virtual environment..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip

log_progress "Installing Review Gate MCP package..."
pip install .

log_progress "Installing optional speech dependencies..."
if pip install ".[speech]"; then
  log_success "Speech dependencies installed successfully"
else
  log_warning "Speech dependency install failed. Review Gate will still work without speech-to-text."
fi

deactivate

log_progress "Configuring Cursor MCP servers..."
mkdir -p "${HOME}/.cursor"

if [[ -f "${CURSOR_MCP_FILE}" ]]; then
  BACKUP_FILE="${CURSOR_MCP_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
  cp "${CURSOR_MCP_FILE}" "${BACKUP_FILE}"
  log_info "Backed up MCP config to ${BACKUP_FILE}"
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${CURSOR_MCP_FILE}" >/dev/null 2>&1; then
    log_error "Existing MCP config is invalid JSON. Fix ${CURSOR_MCP_FILE} and rerun the installer."
    exit 1
  fi
fi

run_install_helper merge-config --config "${CURSOR_MCP_FILE}" --install-dir "${REVIEW_GATE_DIR}"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${CURSOR_MCP_FILE}" >/dev/null
log_success "MCP configuration updated at ${CURSOR_MCP_FILE}"

log_progress "Testing MCP server startup..."
source venv/bin/activate
python -m review_gate_mcp.main > /tmp/review_gate_install_test.log 2>&1 &
SERVER_PID=$!
sleep 5
kill "${SERVER_PID}" >/dev/null 2>&1 || true
wait "${SERVER_PID}" >/dev/null 2>&1 || true
deactivate

if grep -q "Review Gate V3" /tmp/review_gate_install_test.log; then
  log_success "MCP server startup test completed"
else
  log_warning "MCP server startup test was inconclusive. Check /tmp/review_gate_install_test.log if needed."
fi
rm -f /tmp/review_gate_install_test.log

log_progress "Installing Cursor extension..."
if command -v cursor &> /dev/null; then
  if cursor --install-extension "${VSIX_PATH}" >/dev/null 2>&1; then
    log_success "Extension installed via Cursor CLI"
  else
    log_warning "Cursor CLI install failed. Manual extension install may still be required."
  fi
else
  log_info "Cursor CLI not found. Install the VSIX manually from ${REVIEW_GATE_DIR}/$(basename "${VSIX_PATH}")"
fi

if [[ -f "${SCRIPT_DIR}/ReviewGateV2.mdc" && -n "${CURSOR_RULES_DIR}" ]]; then
  mkdir -p "${CURSOR_RULES_DIR}"
  cp "${SCRIPT_DIR}/ReviewGateV2.mdc" "${CURSOR_RULES_DIR}/ReviewGate.mdc"
  log_success "Installed Cursor rule to ${CURSOR_RULES_DIR}/ReviewGate.mdc"
fi

log_progress "Cleaning temporary files..."
rm -f /tmp/review_gate_* /tmp/mcp_response* 2>/dev/null || true
TEMP_DIR=$(python3 -c 'import tempfile; print(tempfile.gettempdir())')
rm -f "${TEMP_DIR}"/review_gate_* "${TEMP_DIR}"/mcp_response* 2>/dev/null || true

echo ""
log_success "Review Gate V3 installation complete"
log_step "MCP server directory: ${REVIEW_GATE_DIR}"
log_step "MCP config: ${CURSOR_MCP_FILE}"
log_step "VSIX package: ${REVIEW_GATE_DIR}/$(basename "${VSIX_PATH}")"
echo ""
log_step "Next steps:"
log_step "1. Restart Cursor"
log_step "2. Run 'reviewGate.openChat' or press Cmd/Ctrl+Shift+R"
log_step "3. Ask Cursor Agent to call the 'review_gate_chat' MCP tool"
