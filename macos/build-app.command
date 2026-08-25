#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
PACKAGE_ROOT="${PROJECT_DIR:h:h}"
APP_DIR="${PROJECT_DIR}/dist/Boujoy Harness.app"
DESKTOP_APP="${HOME}/Desktop/Boujoy Harness.app"
CONTENTS="${APP_DIR}/Contents"
RESOURCES="${CONTENTS}/Resources"
MACOS="${CONTENTS}/MacOS"
BUILD_DIR="$(/usr/bin/mktemp -d /tmp/boujoy-harness-build.XXXXXX)"
SDK_PATH="$(/usr/bin/xcrun --show-sdk-path)"
trap '/bin/rm -rf -- "${BUILD_DIR}"' EXIT

INSTALL_APP=false
RELAUNCH_APP=false
PORTABLE_ROOT=""
while (( $# )); do
  case "$1" in
    --install) INSTALL_APP=true ;;
    --relaunch) INSTALL_APP=true; RELAUNCH_APP=true ;;
    --portable-root)
      shift
      (( $# )) || { echo "--portable-root 后需要目录路径" >&2; exit 2; }
      PORTABLE_ROOT="$1"
      INSTALL_APP=true
      ;;
    *) echo "用法：build-app.command [--install] [--relaunch] [--portable-root DIR]" >&2; exit 2 ;;
  esac
  shift
done

INSTALLED_CONFIG="${DESKTOP_APP}/Contents/Resources/boujoy-config.json"
installed_config_value() {
  [[ -f "${INSTALLED_CONFIG}" ]] || return 1
  /usr/bin/plutil -extract "$1" raw "${INSTALLED_CONFIG}" 2>/dev/null
}

# No developer-machine paths are committed into the source. Explicit build
# environment wins; otherwise reuse an existing local install, then fall back
# to the conventional package layout beside src/.
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

CONFIG_VAULT="${VAULT_DIR}"
CONFIG_DSH_ROOT="${DSH_ROOT}"
CONFIG_KNOWLEDGE_HOME="${DSH_ROOT}/home"
CONFIG_CLEAN_HOME="${DSH_ROOT}/clean-home"
CONFIG_PYTHON="${PYTHON_BIN}"
if [[ -n "${PORTABLE_ROOT}" ]]; then
  PORTABLE_ROOT="${PORTABLE_ROOT:A}"
  [[ "${PORTABLE_ROOT}" != "/" && -d "${PORTABLE_ROOT}/vault" && -d "${PORTABLE_ROOT}/runtime/DeepSeekHarness" ]] || {
    echo "便携包目录必须同时包含 vault/ 与 runtime/DeepSeekHarness/：${PORTABLE_ROOT}" >&2
    exit 1
  }
  DSH_ROOT="${PORTABLE_ROOT}/runtime/DeepSeekHarness"
  DESKTOP_APP="${PORTABLE_ROOT}/Boujoy Harness.app"
  CONFIG_VAULT="vault"
  CONFIG_DSH_ROOT="runtime/DeepSeekHarness"
  CONFIG_KNOWLEDGE_HOME="runtime/DeepSeekHarness/home"
  CONFIG_CLEAN_HOME="runtime/DeepSeekHarness/clean-home"
  if [[ -x "${PORTABLE_ROOT}/runtime/python/bin/python3" ]]; then
    CONFIG_PYTHON="runtime/python/bin/python3"
  else
    CONFIG_PYTHON="python3"
  fi
  "${SCRIPT_DIR}/make-runtime-portable.command" "${PORTABLE_ROOT}"
  /bin/cp "${SCRIPT_DIR}/open-portable.command" "${PORTABLE_ROOT}/启动 Boujoy Harness.command"
  /bin/chmod 755 "${PORTABLE_ROOT}/启动 Boujoy Harness.command"
  /bin/cp "${SCRIPT_DIR}/PORTABLE-README.zh-CN.md" "${PORTABLE_ROOT}/README.md"
  /bin/cp "${SCRIPT_DIR}/PORTABLE-README.zh-CN.md" "${PORTABLE_ROOT}/使用说明书.md"
  /bin/cp "${SCRIPT_DIR}/PORTABLE-RELEASE-STATUS.md" "${PORTABLE_ROOT}/RELEASE-STATUS.md"
fi
[[ -x "${DSH_ROOT}/node_modules/.bin/dsh" ]] || { echo "未找到 DeepSeek Harness 运行时。首次安装请运行 ./macos/setup.command。" >&2; exit 1; }
if [[ -z "${PORTABLE_ROOT}" || ! -x "${PORTABLE_ROOT}/runtime/python/bin/python3" ]]; then
  [[ -x "${PYTHON_BIN}" ]] || { echo "未找到 Python。首次安装请运行 ./macos/setup.command，或设置 BOUJOY_PYTHON_BIN。" >&2; exit 1; }
fi

/bin/rm -rf -- "${APP_DIR}"
/bin/mkdir -p "${MACOS}" "${RESOURCES}"
/bin/mkdir -p "${BUILD_DIR}/clang-cache" "${BUILD_DIR}/swift-cache"
CLANG_MODULE_CACHE_PATH="${BUILD_DIR}/clang-cache" SWIFT_MODULE_CACHE_PATH="${BUILD_DIR}/swift-cache" \
  /usr/bin/swiftc -O -sdk "${SDK_PATH}" -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit -framework Foundation -framework UniformTypeIdentifiers \
  "${SCRIPT_DIR}/BoujoyHarness.swift" -o "${MACOS}/BoujoyHarness"
/bin/cp "${SCRIPT_DIR}/Info.plist" "${CONTENTS}/Info.plist"
/bin/cp "${PROJECT_DIR}/web/index.html" "${PROJECT_DIR}/web/app.css" "${PROJECT_DIR}/web/app.js" "${PROJECT_DIR}/web/boujoy_server.py" "${RESOURCES}/"
/bin/cp "${PROJECT_DIR}/web/manifest.json" "${PROJECT_DIR}/web/icon-192.png" "${PROJECT_DIR}/web/icon-512.png" "${RESOURCES}/"
/bin/cp "${PROJECT_DIR}/assets/punk-collage-bg.png" "${PROJECT_DIR}/assets/punk-collage-dark.png" "${PROJECT_DIR}/assets/fusion-pixel-10px-proportional-zh_hans.otf.woff2" "${RESOURCES}/"

/bin/cp "${PROJECT_DIR}/assets/BoujoyHarness.icns" "${RESOURCES}/BoujoyHarness.icns"

/usr/bin/plutil -create xml1 "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -insert vault -string "${CONFIG_VAULT}" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -insert dshRoot -string "${CONFIG_DSH_ROOT}" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -insert knowledgeHome -string "${CONFIG_KNOWLEDGE_HOME}" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -insert cleanHome -string "${CONFIG_CLEAN_HOME}" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -insert python -string "${CONFIG_PYTHON}" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/plutil -convert json -o "${RESOURCES}/boujoy-config.json" "${BUILD_DIR}/boujoy-config.plist"
/usr/bin/codesign --force --deep --sign - "${APP_DIR}"
/usr/bin/codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
echo "已构建：${APP_DIR}"

if ${INSTALL_APP}; then
  INSTALL_DIR="$(/usr/bin/mktemp -d /tmp/boujoy-harness-install.XXXXXX)"
  BACKUP_DIR="$(/usr/bin/mktemp -d /tmp/boujoy-harness-backup.XXXXXX)"
  STAGED_APP="${INSTALL_DIR}/Boujoy Harness.app"
  /usr/bin/ditto "${APP_DIR}" "${STAGED_APP}"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "${STAGED_APP}"

  if [[ -d "${DESKTOP_APP}" ]]; then
    /bin/mv "${DESKTOP_APP}" "${BACKUP_DIR}/Boujoy Harness.app"
  fi
  if ! /bin/mv "${STAGED_APP}" "${DESKTOP_APP}"; then
    [[ -d "${BACKUP_DIR}/Boujoy Harness.app" ]] && /bin/mv "${BACKUP_DIR}/Boujoy Harness.app" "${DESKTOP_APP}"
    echo "桌面 App 安装失败，已恢复旧版本。" >&2
    exit 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "${DESKTOP_APP}"; then
    /bin/rm -rf -- "${DESKTOP_APP}"
    [[ -d "${BACKUP_DIR}/Boujoy Harness.app" ]] && /bin/mv "${BACKUP_DIR}/Boujoy Harness.app" "${DESKTOP_APP}"
    echo "桌面 App 签名校验失败，已恢复旧版本。" >&2
    exit 1
  fi
  /bin/rm -rf -- "${INSTALL_DIR}" "${BACKUP_DIR}"
  echo "已安装：${DESKTOP_APP}"
fi

if ${RELAUNCH_APP}; then
  if /usr/bin/curl --noproxy '*' -fsS http://127.0.0.1:8766/api/heartbeat >/dev/null 2>&1; then
    /usr/bin/curl --noproxy '*' -fsS -X POST http://127.0.0.1:8766/api/app/restart >/dev/null
    echo "已通过 App 请求重启：${DESKTOP_APP}"
  else
    /usr/bin/open -n -- "${DESKTOP_APP}"
    echo "服务未运行，已直接打开：${DESKTOP_APP}"
  fi
fi
