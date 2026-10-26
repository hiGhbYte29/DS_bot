#!/usr/bin/env python3
"""AI-assisted, offline publication checks against the complete Git index.

This is a conservative guard, not a complete secret detector. No file contents
or matched credential values are printed. Review the staged diff before pushing.
"""

import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
BLOCKED_DIRS = {
    ".git", "node_modules", ".npm-cache", "state", "data", "backups", "logs",
    "runtime", "qq-data", "qq-config", "audio", ".dsh", ".ssh", "__pycache__",
}
BLOCKED_NAMES = {
    "config.json", "console-token", "cookies.json", "cookies.txt",
    "_snowluma-catalog.json", "ACCESS.txt",
}
BLOCKED_SUFFIXES = (
    ".log", ".bak", ".tar", ".tar.gz", ".tgz", ".zip", ".7z", ".db",
    ".sqlite", ".sqlite3", ".jsonl", ".jsonl.zstd", ".pem", ".key", ".p12", ".pfx",
)
SECRET_PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE" + r" KEY-----"),
    "github-token": re.compile(r"\bgh[pousr]_" + r"[A-Za-z0-9]{30,}\b"),
    "github-fine-grained-token": re.compile(r"\bgithub_pat_" + r"[A-Za-z0-9_]{40,}\b"),
    "api-key": re.compile(r"\bsk-" + r"[A-Za-z0-9_-]{24,}\b"),
}


def git(*args, input_data=None):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], input=input_data,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )


def main():
    result = git("ls-files", "--stage", "-z")
    if result.returncode:
        print("FAIL: run inside the prepared Git repository; unable to read index.")
        return 1
    problems = []
    entries = []
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        meta, raw_name = record.split(b"\t", 1)
        mode, oid, stage = meta.decode().split()
        name = raw_name.decode("utf-8")
        entries.append((name, oid))
        path = PurePosixPath(name)
        if mode not in {"100644", "100755"} or stage != "0":
            problems.append((name, "non-regular file, nested repository or unresolved conflict"))
        if (set(path.parts) & BLOCKED_DIRS or path.name in BLOCKED_NAMES
                or path.name.endswith(BLOCKED_SUFFIXES)
                or (path.name.startswith(".env") and path.name != ".env.example")
                or re.fullmatch(r"onebot_.*\.json", path.name)
                or "credentials" in path.name.lower()):
            problems.append((name, "private/runtime filename"))
        if path.parts[0] == "snowluma" and name != "snowluma/README.md":
            problems.append((name, "SnowLuma documentation-only boundary"))
        if name.startswith("qq-bridge/roles/") and not (
            path.name == "README.md" or path.name.endswith(".example.md")
        ):
            problems.append((name, "non-example persona"))

        blob = git("cat-file", "blob", oid)
        if blob.returncode:
            problems.append((name, "unable to read staged blob"))
            continue
        if b"\0" in blob.stdout:
            continue
        content = blob.stdout.decode("utf-8", errors="replace")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(content):
                problems.append((name, label))
        if name == "qq-bridge/config.example.json":
            try:
                config = json.loads(content)
                if (config.get("ownerQQ") not in (None, "", 0)
                        or config.get("allowAllWhenEmpty") is not False
                        or any(config.get(section, {}).get(key, [])
                               for section in ("allow", "deny") for key in ("private", "groups"))):
                    problems.append((name, "example contains account IDs or unsafe allow default"))

                def inspect(value):
                    if isinstance(value, dict):
                        for key, child in value.items():
                            if key.lower() in {"token", "accesstoken", "authtoken", "consoletoken", "apikey", "password", "secret"} and child:
                                problems.append((name, "nonempty example credential"))
                            inspect(child)
                    elif isinstance(value, list):
                        for child in value:
                            inspect(child)
                inspect(config)
            except (ValueError, TypeError):
                problems.append((name, "invalid example JSON"))

    if not entries:
        problems.append(("<index>", "nothing staged/tracked to inspect"))
    else:
        names = b"\0".join(name.encode() for name, _ in entries) + b"\0"
        ignored = git("check-ignore", "--no-index", "--stdin", "-z", input_data=names)
        if ignored.returncode not in (0, 1):
            problems.append((".gitignore", "unable to validate ignored paths"))
        for name in ignored.stdout.split(b"\0"):
            if name:
                problems.append((name.decode(), "tracked despite ignore rule"))
    for name, reason in sorted(set(problems)):
        print(f"FAIL: {name}: {reason}")
    if problems:
        return 1
    print(f"PASS: {len(entries)} staged/tracked files; no blocked paths or supported secret patterns.")
    print("Review private identifiers and the diff separately; this does not scan Git history.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
