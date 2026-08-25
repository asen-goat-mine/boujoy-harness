#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
PACKAGE_ROOT="${PROJECT_DIR:h:h}"
DESKTOP_APP="${HOME}/Desktop/Boujoy Harness.app"
INSTALLED_CONFIG="${DESKTOP_APP}/Contents/Resources/boujoy-config.json"

installed_config_value() {
  [[ -f "${INSTALLED_CONFIG}" ]] || return 1
  /usr/bin/plutil -extract "$1" raw "${INSTALLED_CONFIG}" 2>/dev/null
}

VAULT_DIR="${BOUJOY_VAULT_DIR:-$(installed_config_value vault || true)}"
DSH_ROOT="${BOUJOY_DSH_ROOT:-$(installed_config_value dshRoot || true)}"
PYTHON_BIN="${BOUJOY_PYTHON_BIN:-$(installed_config_value python || true)}"
[[ -n "${VAULT_DIR}" ]] || VAULT_DIR="${PACKAGE_ROOT}/vault"
[[ -n "${DSH_ROOT}" ]] || DSH_ROOT="${PACKAGE_ROOT}/runtime/DeepSeekHarness"
if [[ -z "${PYTHON_BIN}" || ! -x "${PYTHON_BIN}" ]]; then
  [[ -x "${PACKAGE_ROOT}/runtime/python/bin/python3" ]] && PYTHON_BIN="${PACKAGE_ROOT}/runtime/python/bin/python3"
fi
if [[ -z "${PYTHON_BIN}" || ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="$(/usr/bin/which python3 2>/dev/null || true)"
fi

FAILURES=0
check() {
  local label="$1"
  local ok="$2"
  local detail="$3"
  if [[ "${ok}" == "yes" ]]; then
    print "[OK]   ${label}: ${detail}"
  else
    print "[FAIL] ${label}: ${detail}"
    FAILURES=$((FAILURES + 1))
  fi
}

print "Boujoy Harness / macOS Doctor"
print "--------------------------------"
check "macOS" "$([[ "$(/usr/bin/uname -s)" == "Darwin" ]] && print yes || print no)" "$(/usr/bin/sw_vers -productVersion 2>/dev/null || /usr/bin/uname -s)"
check "Apple Silicon" "$([[ "$(/usr/bin/uname -m)" == "arm64" ]] && print yes || print no)" "$(/usr/bin/uname -m)"
check "Xcode command-line tools" "$([[ -x /usr/bin/xcrun ]] && /usr/bin/xcrun --find swiftc >/dev/null 2>&1 && print yes || print no)" "run xcode-select --install if missing"
check "DeepSeek Harness" "$([[ -x "${DSH_ROOT}/node_modules/.bin/dsh" ]] && print yes || print no)" "${DSH_ROOT}"
check "Markdown Vault" "$([[ -d "${VAULT_DIR}" ]] && print yes || print no)" "${VAULT_DIR}"
check "Python 3" "$([[ -n "${PYTHON_BIN}" && -x "${PYTHON_BIN}" ]] && print yes || print no)" "${PYTHON_BIN:-not found}"

print "--------------------------------"
if (( FAILURES > 0 )); then
  print "${FAILURES} check(s) need attention. Run ./macos/setup.command for guided setup."
  exit 1
fi
print "All required local components are ready."
