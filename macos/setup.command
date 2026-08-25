#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
PACKAGE_ROOT="${PROJECT_DIR:h:h}"
DESKTOP_APP="${HOME}/Desktop/Boujoy Harness.app"
INSTALLED_CONFIG="${DESKTOP_APP}/Contents/Resources/boujoy-config.json"

installed_config_value() {
  [[ -f "${INSTALLED_CONFIG}" ]] || return 1
  /usr/bin/plutil -extract "$1" raw "${INSTALLED_CONFIG}" 2>/dev/null
}

choose_folder() {
  local prompt="$1"
  /usr/bin/osascript -e "POSIX path of (choose folder with prompt \"${prompt}\")" 2>/dev/null | /usr/bin/sed 's#/$##'
}

first_dsh_root() {
  local candidate
  for candidate in \
    "${BOUJOY_DSH_ROOT:-}" \
    "$(installed_config_value dshRoot || true)" \
    "${PACKAGE_ROOT}/runtime/DeepSeekHarness" \
    "${PROJECT_DIR:h}/deepseek-harness" \
    "${HOME}/src/deepseek-harness" \
    "${HOME}/deepseek-harness"; do
    [[ -n "${candidate}" && -x "${candidate}/node_modules/.bin/dsh" ]] && { print "${candidate}"; return 0; }
  done
  return 1
}

first_python() {
  local candidate
  for candidate in \
    "${BOUJOY_PYTHON_BIN:-}" \
    "$(installed_config_value python || true)" \
    "${PACKAGE_ROOT}/runtime/python/bin/python3" \
    "$(/usr/bin/which python3 2>/dev/null || true)"; do
    [[ -n "${candidate}" && -x "${candidate}" ]] && { print "${candidate}"; return 0; }
  done
  return 1
}

print "Boujoy Harness guided setup"
print "============================"

DSH_ROOT="$(first_dsh_root || true)"
if [[ -z "${DSH_ROOT}" ]]; then
  print "DeepSeek Harness was not detected automatically."
  print "Select the folder that contains node_modules/.bin/dsh."
  DSH_ROOT="$(choose_folder "选择 DeepSeek Harness 文件夹")" || {
    print "Setup cancelled. Install and build DeepSeek Harness, then run this file again." >&2
    exit 1
  }
fi
[[ -x "${DSH_ROOT}/node_modules/.bin/dsh" ]] || {
  print "The selected folder does not contain node_modules/.bin/dsh: ${DSH_ROOT}" >&2
  exit 1
}

VAULT_DIR="${BOUJOY_VAULT_DIR:-$(installed_config_value vault || true)}"
[[ -d "${VAULT_DIR}" ]] || VAULT_DIR=""
if [[ -z "${VAULT_DIR}" && -d "${PACKAGE_ROOT}/vault" ]]; then
  VAULT_DIR="${PACKAGE_ROOT}/vault"
fi
if [[ -z "${VAULT_DIR}" ]]; then
  choice="$(/usr/bin/osascript -e 'button returned of (display dialog "选择已有 Markdown 知识库，或创建一个空知识库。" buttons {"取消", "创建空知识库", "选择已有知识库"} default button "选择已有知识库" cancel button "取消")' 2>/dev/null || true)"
  case "${choice}" in
    选择已有知识库)
      VAULT_DIR="$(choose_folder "选择 Markdown 知识库文件夹")" || exit 1
      ;;
    创建空知识库)
      VAULT_DIR="${HOME}/Documents/Boujoy Vault"
      /bin/mkdir -p "${VAULT_DIR}"
      if [[ ! -f "${VAULT_DIR}/README.md" ]]; then
        print "# Boujoy Vault\n\nLocal Markdown workspace for Boujoy Harness.\n" > "${VAULT_DIR}/README.md"
      fi
      ;;
    *) print "Setup cancelled."; exit 1 ;;
  esac
fi

PYTHON_BIN="$(first_python || true)"
[[ -n "${PYTHON_BIN}" ]] || {
  print "Python 3 was not found. Install Python 3, then run this file again." >&2
  exit 1
}

print ""
print "Configuration"
print "  DeepSeek Harness: ${DSH_ROOT}"
print "  Markdown Vault:   ${VAULT_DIR}"
print "  Python:           ${PYTHON_BIN}"
print ""

export BOUJOY_DSH_ROOT="${DSH_ROOT}"
export BOUJOY_VAULT_DIR="${VAULT_DIR}"
export BOUJOY_PYTHON_BIN="${PYTHON_BIN}"
"${SCRIPT_DIR}/doctor.command"
"${SCRIPT_DIR}/build-app.command" --install
/usr/bin/open -n -- "${DESKTOP_APP}"
print "Boujoy Harness is installed and opening now."
