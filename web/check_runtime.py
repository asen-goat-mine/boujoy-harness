"""Check the installed upstream protocol version without starting the runtime."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

SUPPORTED_VERSION = "0.1.1-rc.2"


def installed_version(root: Path) -> str:
    installed = root / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
    manifest = installed if installed.exists() else root / "package.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise ValueError("Cannot read the installed DeepSeek Harness package manifest.") from error
    if not isinstance(data, dict) or data.get("name") not in ("@deepseek-ai/dsh", "@deepseek-ai/dsh-root"):
        raise ValueError("No installed DeepSeek Harness package was found; a dependency declaration alone is insufficient.")
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError("The installed DeepSeek Harness package has no version.")
    return version


def check_runtime(root: Path) -> str:
    version = installed_version(root)
    if version != SUPPORTED_VERSION:
        raise ValueError(
            f"DeepSeek Harness {version} is not supported by this Boujoy adapter. "
            f"Use {SUPPORTED_VERSION}; newer remote-stream/history protocols require an adapter update. "
            "See docs/UPSTREAM-COMPATIBILITY.md in the source repository."
        )
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="DeepSeek Harness installation root")
    args = parser.parse_args()
    try:
        version = check_runtime(args.root)
    except ValueError as error:
        print(f"[FAIL] {error}")
        return 1
    print(f"[OK] DeepSeek Harness protocol: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
