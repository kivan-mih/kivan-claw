#!/usr/bin/env python3
"""OpenClaw kastomny uninstaller.

Reverses install.py against the same JSON config. Runs `docker compose down`
to drop containers/networks/local-built images, then removes the cwd-side
artifacts (.env, docker-compose.yml, .gitconfig, cp-openclaw-proxy/) and
${OPENCLAW_CONFIG_DIR}-templates/. The ${OPENCLAW_CONFIG_DIR} volume directory
is emptied but kept in place.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

PROXY_DIR_NAME = "cp-openclaw-proxy"
CWD_FILES = (".env", "docker-compose.yml", ".gitconfig")


def err(msg: str) -> None:
    print(f"uninstall.py: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    err(msg)
    sys.exit(code)


def load_config(path: Path) -> dict:
    if not path.is_file():
        die(f"config file not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"config file is not valid JSON: {e}")


def docker_compose_down(cwd: Path) -> None:
    compose = cwd / "docker-compose.yml"
    if not compose.is_file():
        print(f"no docker-compose.yml at {compose}; skipping docker teardown")
        return
    try:
        result = subprocess.run(
            ["docker", "compose", "down", "--rmi", "local", "--remove-orphans"],
            cwd=str(cwd),
            check=False,
        )
    except FileNotFoundError:
        print("docker not on PATH; skipping docker teardown")
        return
    if result.returncode != 0:
        # Continue with host-side cleanup either way — partial teardown is
        # better than aborting and leaving the operator stuck.
        print(f"docker compose down exited {result.returncode}; continuing")


def remove_path(p: Path) -> None:
    if not p.exists() and not p.is_symlink():
        return
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    else:
        p.unlink()
    print(f"removed {p}")


def clear_dir_contents(p: Path) -> None:
    if not p.is_dir():
        print(f"{p} not present; skipping volume clear")
        return
    for child in p.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    print(f"cleared contents of {p} (directory kept)")


def confirm(cwd: Path, config_dir: Path, templates_dir: Path, yes: bool) -> None:
    if yes:
        return
    print("uninstall will remove:")
    print(f"  - docker containers / networks / local-built images for the project at {cwd}")
    for f in CWD_FILES:
        print(f"  - {cwd / f}")
    print(f"  - {cwd / PROXY_DIR_NAME}/")
    print(f"  - {templates_dir}/")
    print(f"  - contents of {config_dir}/ (the directory itself is kept)")
    print()
    if not sys.stdin.isatty():
        die("no TTY available for confirmation; rerun with --yes to proceed")
    try:
        ans = input("proceed? [y/N] ").strip().lower()
    except EOFError:
        die("no input received; rerun with --yes to proceed")
    if ans not in ("y", "yes"):
        print("aborted; nothing removed")
        sys.exit(0)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("config", type=Path, help="install JSON config (same as install.py)")
    p.add_argument(
        "--cwd",
        type=Path,
        default=Path.cwd(),
        help="install directory (default: current working dir)",
    )
    p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="skip the interactive confirmation prompt",
    )
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)

    env_in = cfg.get("env") or {}
    if not isinstance(env_in, dict):
        die("config.env must be an object")

    config_dir_raw = str(env_in.get("OPENCLAW_CONFIG_DIR", "")).strip()
    if not config_dir_raw:
        die("OPENCLAW_CONFIG_DIR missing from config; cannot determine volume path")
    config_dir = Path(config_dir_raw).expanduser()
    templates_dir = config_dir.parent / (config_dir.name + "-templates")

    confirm(args.cwd, config_dir, templates_dir, args.yes)

    docker_compose_down(args.cwd)

    for f in CWD_FILES:
        remove_path(args.cwd / f)
    remove_path(args.cwd / PROXY_DIR_NAME)

    remove_path(templates_dir)
    clear_dir_contents(config_dir)

    print()
    print("uninstall complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
