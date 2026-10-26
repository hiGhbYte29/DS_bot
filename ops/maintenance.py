#!/usr/bin/env python3
"""AI-assisted private configuration snapshots; never copy chat histories or logs."""

import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import uuid


PREFIX = "ds-bot-config-auto-"
BACKUP_NAME = re.compile(r"ds-bot-config-auto-\d{8}T\d{6}Z-[0-9a-f]{8}\.tar\.gz\Z")
KEEP = 7
MAX_CONFIG_BYTES = 32 * 1024 * 1024
STATE_FILES = (
    "mode.json", "current-role.json", "initial-prompts.json",
    "console-token",
)
PROFILE_FILES = (
    "cordis.yml", "cordis.yaml", "cordis.patch.yml", "cordis.patch.yaml",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
)


def regular_file(path):
    """Reject symlinks, including symlinked parent directories."""
    try:
        return (not any(p.is_symlink() for p in (path, *path.parents))
                and stat.S_ISREG(path.lstat().st_mode))
    except FileNotFoundError:
        return False


def candidates(project, home, include_dsh=False):
    """Explicit restore inputs, not a recursive copy of either application."""
    files = {}

    def add(path, archive_name):
        if regular_file(path):
            if path.stat().st_size > MAX_CONFIG_BYTES:
                raise RuntimeError("configuration file exceeds 32 MiB limit")
            files[archive_name] = path

    for name in ("qq-bridge/config.json",):
        add(project / name, "project/" + name)
    for name in STATE_FILES:
        add(project / "qq-bridge/state" / name, "project/qq-bridge/state/" + name)
    # Roles are user-facing prompt configuration, not session history.
    for p in sorted((project / "qq-bridge/roles").glob("*.md")):
        add(p, "project/qq-bridge/roles/" + p.name)
    for name in ("maintenance.py", "status.mjs", "README.md"):
        add(project / "ops" / name, "project/ops/" + name)
    for p in sorted((project / "ops/systemd").glob("*")):
        if p.name.endswith((".service.example", ".target.example")):
            add(p, "project/ops/systemd/" + p.name)
    if include_dsh:
        dsh = Path(os.environ.get("DSH_HOME", str(home / ".dsh"))).expanduser().absolute()
        add(dsh / ".credentials.yaml", "dsh/.credentials.yaml")
        for name in ("cordis.patch.yml", "cordis.patch.yaml"):
            add(dsh / name, "dsh/" + name)
        for profile in sorted((dsh / "profiles").glob("*")):
            if profile.is_dir() and not profile.is_symlink():
                for name in PROFILE_FILES:
                    add(profile / name, "dsh/profiles/" + profile.name + "/" + name)
    systemd = home / ".config/systemd/user"
    for name in ("ds-bot.target", "ds-bot-dsh.service", "ds-bot-bridge.service"):
        add(systemd / name, "systemd-user/" + name)
        dropins = systemd / (name + ".d")
        if dropins.is_dir() and not dropins.is_symlink():
            for conf in sorted(dropins.glob("*.conf")):
                add(conf, "systemd-user/" + dropins.name + "/" + conf.name)
    return dict(sorted(files.items()))


def owned_backups(directory):
    if not directory.is_dir():
        return []
    return sorted((p for p in directory.iterdir()
                   if BACKUP_NAME.fullmatch(p.name) and regular_file(p)),
                  key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)


def verify_archive(path):
    """Validate every member against hashes without printing secret contents."""
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        if any(not m.isfile() or m.name.startswith("/")
               or ".." in Path(m.name).parts for m in members):
            raise RuntimeError("invalid snapshot members")
        manifest = json.load(archive.extractfile("MANIFEST.json"))
        expected = {item["path"]: item for item in manifest["files"]}
        if (len(expected) != len(manifest["files"])
                or len(members) != len(expected) + 1
                or {m.name for m in members} != set(expected) | {"MANIFEST.json"}):
            raise RuntimeError("snapshot manifest mismatch")
        for member in members:
            if member.name == "MANIFEST.json":
                continue
            item = expected[member.name]
            if member.size != item["size"] or member.mode != 0o600:
                raise RuntimeError("snapshot member metadata mismatch")
            digest = hashlib.sha256()
            with archive.extractfile(member) as source:
                while block := source.read(1024 * 1024):
                    digest.update(block)
            if digest.hexdigest() != item["sha256"]:
                raise RuntimeError("snapshot checksum mismatch")
        return len(expected)


def snapshot(project, home, dry_run=False, include_dsh=False):
    project, home = Path(project).absolute(), Path(home).absolute()
    directory = project / "backups"
    files = candidates(project, home, include_dsh)
    required = {"project/qq-bridge/config.json"}
    if not required.issubset(files):
        raise RuntimeError("required configuration is missing; no backup or pruning performed")
    existing = owned_backups(directory)
    if dry_run:
        return {"dry_run": True, "files": list(files), "file_count": len(files),
                "backup_directory": str(directory), "keep": KEEP,
                "would_prune_after_success": [p.name for p in existing[KEEP - 1:]],
                "includes_dsh": include_dsh,
                "logs": "unchanged; application-native retention"}
    if directory.is_symlink() or any(p.is_symlink() for p in directory.parents):
        raise RuntimeError("backup directory must not be a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    lock_path = directory / ".ds-bot-maintenance.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"skipped": True, "reason": "another maintenance run holds the lock"}
        # Re-read the list under the lock; other runs may have completed.
        files = candidates(project, home, include_dsh)
        if not required.issubset(files):
            raise RuntimeError("required configuration disappeared; no pruning performed")
        now = dt.datetime.now(dt.timezone.utc)
        name = PREFIX + now.strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8] + ".tar.gz"
        destination = directory / name
        temporary = directory / ("." + name + ".tmp")
        manifest = {"format": 1, "created_at": now.isoformat(), "files": []}
        try:
            with temporary.open("xb") as output:
                os.fchmod(output.fileno(), 0o600)
                with tarfile.open(fileobj=output, mode="w:gz") as archive:
                    for archive_name, source in files.items():
                        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(fd, "rb") as source_file:
                            if not stat.S_ISREG(os.fstat(source_file.fileno()).st_mode):
                                raise RuntimeError("configuration is no longer a regular file")
                            payload = source_file.read(MAX_CONFIG_BYTES + 1)
                        if len(payload) > MAX_CONFIG_BYTES:
                            raise RuntimeError("configuration file exceeds 32 MiB limit")
                        info = tarfile.TarInfo(archive_name)
                        info.size, info.mode, info.mtime = len(payload), 0o600, int(now.timestamp())
                        archive.addfile(info, io.BytesIO(payload))
                        manifest["files"].append({"path": archive_name, "size": len(payload),
                                                  "sha256": hashlib.sha256(payload).hexdigest()})
                    payload = (json.dumps(manifest, indent=2) + "\n").encode()
                    info = tarfile.TarInfo("MANIFEST.json")
                    info.size, info.mode, info.mtime = len(payload), 0o600, int(now.timestamp())
                    archive.addfile(info, io.BytesIO(payload))
                output.flush()
                os.fsync(output.fileno())
            count = verify_archive(temporary)
            temporary.rename(destination)
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            removed = []
            for old in owned_backups(directory)[KEEP:]:
                old.unlink()
                removed.append(old.name)
            return {"backup": str(destination), "verified_files": count,
                    "mode": "0600", "directory_mode": "0700", "pruned": removed,
                    "logs": "unchanged; application-native retention"}
        finally:
            temporary.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="preview without creating or changing any file")
    parser.add_argument("--include-dsh", action="store_true",
                        help="also snapshot DSH credentials and profile configuration (contains secrets)")
    parser.add_argument("--verify-backup", type=Path, help="read and verify one snapshot without extracting it")
    args = parser.parse_args()
    try:
        if args.verify_backup:
            result = {"verified_files": verify_archive(args.verify_backup), "valid": True}
        else:
            result = snapshot(Path(__file__).resolve().parents[1], Path.home(), args.dry_run, args.include_dsh)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        # OS/parser exceptions can include source fragments; do not echo them.
        print(json.dumps({"ok": False, "error_type": type(error).__name__,
                          "message": "maintenance failed; no secret contents were printed"}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
