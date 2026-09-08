#!/usr/bin/env python3
"""Assert serve/rpc.rs dispatch arms cover exactly the ipc/commands.json table.

Run from anywhere: python3 scripts/check-serve-dispatch.py
Exit 1 with the diff if the two sets drift apart.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RPC = ROOT / "src-tauri/src/serve/rpc.rs"
COMMANDS = ROOT / "ipc/commands.json"


def main() -> int:
    arms = set(re.findall(r'^\s*"([a-z0-9_]+)"\s*=>', RPC.read_text(), re.M))
    listed = {
        name
        for group in json.loads(COMMANDS.read_text()).values()
        for name in group
    }
    missing = sorted(listed - arms)
    extra = sorted(arms - listed)
    if missing or extra:
        print(f"missing arms: {missing}", file=sys.stderr)
        print(f"arms not in commands.json: {extra}", file=sys.stderr)
        return 1
    print(f"dispatch covers all {len(listed)} commands in ipc/commands.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
