#!/bin/bash

# Review Gate V3 - Uninstaller Script

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
log_header() { echo -e "${BLUE}$1${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
CURSOR_MCP_FILE="${HOME}/.cursor/mcp.json"
INSTALL_DIRS=(
  "${HOME}/cursor-extensions/review-gate-v3"
)

run_install_helper() {
  PYTHONPATH="${SCRIPT_DIR}" python3 -m review_gate_mcp.install_utils "$@"
}

log_header "Review Gate V3 - Uninstaller"
log_header "============================="
echo ""

read -p "$(echo -e ${YELLOW}WARNING: Are you sure you want to uninstall Review Gate V3? [y/N]: ${NC})" -n 1 -r
echo
if [[ ! ${REPLY} =~ ^[Yy]$ ]]; then
  log_info "Uninstallation cancelled"
  exit 0
fi

log_progress "Removing Review Gate files..."
for install_dir in "${INSTALL_DIRS[@]}"; do
  if [[ -d "${install_dir}" ]]; then
    rm -rf "${install_dir}"
    log_success "Removed ${install_dir}"
  fi
done

if [[ -f "${CURSOR_MCP_FILE}" ]]; then
  cp "${CURSOR_MCP_FILE}" "${CURSOR_MCP_FILE}.backup"
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${CURSOR_MCP_FILE}" >/dev/null 2>&1; then
    run_install_helper remove-config --config "${CURSOR_MCP_FILE}"
    log_success "Removed Review Gate MCP entries from ${CURSOR_MCP_FILE}"
  else
    log_warning "Skipped MCP config cleanup because ${CURSOR_MCP_FILE} is invalid JSON"
  fi
fi

if [[ "$(uname)" == "Darwin" ]]; then
  CURSOR_RULES_DIR="${HOME}/Library/Application Support/Cursor/User/rules"
elif [[ "$(uname)" == "Linux" ]]; then
  CURSOR_RULES_DIR="${HOME}/.config/Cursor/User/rules"
else
  CURSOR_RULES_DIR=""
fi

if [[ -n "${CURSOR_RULES_DIR}" && -f "${CURSOR_RULES_DIR}/ReviewGate.mdc" ]]; then
  rm -f "${CURSOR_RULES_DIR}/ReviewGate.mdc"
  log_success "Removed Cursor rule file"
fi

rm -f /tmp/review_gate_* /tmp/mcp_response* 2>/dev/null || true
TEMP_DIR=$(python3 -c 'import tempfile; print(tempfile.gettempdir())' 2>/dev/null || echo "/tmp")
rm -f "${TEMP_DIR}"/review_gate_* "${TEMP_DIR}"/mcp_response* 2>/dev/null || true
log_success "Cleaned temporary Review Gate files"

EXTENSION_REMOVED=false
if command -v cursor &> /dev/null; then
  for extension_id in review-gate-v3; do
    if cursor --uninstall-extension "${extension_id}" >/dev/null 2>&1; then
      EXTENSION_REMOVED=true
      log_success "Removed extension ${extension_id}"
    fi
  done
fi

if [[ "${EXTENSION_REMOVED}" == false ]]; then
  log_warning "Automatic extension removal did not run. Remove 'Review Gate V3' from Cursor manually if it is still installed."
fi

echo ""
log_success "Review Gate V3 uninstallation complete"
