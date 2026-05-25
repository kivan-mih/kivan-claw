#!/usr/bin/env python3
"""OpenClaw kastomny installer.

Reads a JSON config and emits:
  - .env (in CWD) with the env vars the user listed
  - docker-compose.yml (in CWD) from templates/docker-compose.yml.tmpl
  - copies templates/openclaw-config/ to ${OPENCLAW_CONFIG_DIR}-templates/
  - mkdirs ${OPENCLAW_CONFIG_DIR} and ${OPENCLAW_WORKSPACE_DIR}

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = REPO_ROOT / "templates"
COMPOSE_TMPL = TEMPLATES_DIR / "docker-compose.yml.tmpl"
OPENCLAW_TMPL_DIR = TEMPLATES_DIR / "openclaw-config"

ENV_KEYS = (
    "TG_BOT_TOKEN",
    "ZAI_TOKEN",
    "BRAVE_SEARCH_TOKEN",
    "HTTP_PROXY",
    "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "OPENCLAW_IMAGE",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_BIND",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_BRIDGE_PORT",
    "OPENCLAW_NETWORK",
    "USER_ACCEPT_PASSWORD",
    "USER_ACCEPT_WELCOME_TEXT",
)

REQUIRED_NONEMPTY = (
    "TG_BOT_TOKEN",
    "ZAI_TOKEN",
    "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "OPENCLAW_IMAGE",
    "OPENCLAW_GATEWAY_BIND",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_BRIDGE_PORT",
    "OPENCLAW_NETWORK",
    "USER_ACCEPT_PASSWORD",
    "USER_ACCEPT_WELCOME_TEXT",
)

# Values that need quoting in .env when written; matches characters that
# Docker Compose v2 dotenv interprets specially or that complicate parsing.
DOTENV_NEEDS_QUOTE = set(" \t\"'#$\\=()")


def err(msg: str) -> None:
    print(f"install.py: {msg}", file=sys.stderr)


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


def quote_dotenv(value: str) -> str:
    if value == "":
        return ""
    if any(c in DOTENV_NEEDS_QUOTE for c in value):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def write_dotenv(env: dict[str, str], dest: Path) -> None:
    lines = []
    for key in ENV_KEYS:
        raw = env.get(key, "")
        lines.append(f"{key}={quote_dotenv(raw)}")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {dest}")


def render_compose(prefix: str, egress_network: str, dest: Path) -> None:
    if not COMPOSE_TMPL.is_file():
        die(f"missing template: {COMPOSE_TMPL}")
    text = COMPOSE_TMPL.read_text(encoding="utf-8")
    text = text.replace("@@PREFIX@@", prefix)
    text = text.replace("@@EGRESS_NETWORK@@", egress_network)
    if "@@" in text:
        die(f"unsubstituted placeholder in {dest}: still contains '@@'")
    dest.write_text(text, encoding="utf-8")
    print(f"wrote {dest}")


def copy_openclaw_templates(src: Path, dst: Path) -> None:
    if not src.is_dir():
        die(f"missing template tree: {src}")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    try:
        os.chmod(dst, 0o700)
    except OSError:
        pass
    print(f"copied {src} -> {dst}")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    print(f"ensured dir {path}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("config", type=Path, help="install JSON config")
    p.add_argument(
        "--cwd",
        type=Path,
        default=Path.cwd(),
        help="output directory (default: current working dir)",
    )
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)

    prefix = cfg.get("prefix", "").strip()
    if not prefix:
        die("config.prefix is required and must be non-empty")
    if not all(c.isalnum() or c in "-_" for c in prefix):
        die("config.prefix must contain only [A-Za-z0-9_-]")

    egress_suffix = cfg.get("egress_network_suffix", "egress").strip()
    if not egress_suffix:
        die("config.egress_network_suffix must be non-empty")

    env_in = cfg.get("env") or {}
    if not isinstance(env_in, dict):
        die("config.env must be an object")

    env: dict[str, str] = {}
    for k in ENV_KEYS:
        v = env_in.get(k, "")
        if v is None:
            v = ""
        env[k] = str(v)

    missing = [k for k in REQUIRED_NONEMPTY if not env[k]]
    if missing:
        die(f"required env keys are empty: {', '.join(missing)}")

    if not env["OPENCLAW_GATEWAY_TOKEN"]:
        env["OPENCLAW_GATEWAY_TOKEN"] = secrets.token_hex(32)
        print("OPENCLAW_GATEWAY_TOKEN was empty; generated a fresh 64-hex token")

    # Derive egress network name from the prefix (not from OPENCLAW_NETWORK)
    # so the two names share the same base without compounding suffixes:
    # prefix="kivan-claw", suffix="egress" -> "kivan-claw-egress".
    egress_network = f"{prefix}-{egress_suffix}"

    out_env = args.cwd / ".env"
    out_compose = args.cwd / "docker-compose.yml"
    config_dir = Path(env["OPENCLAW_CONFIG_DIR"]).expanduser()
    workspace_dir = Path(env["OPENCLAW_WORKSPACE_DIR"]).expanduser()
    templates_target = Path(str(config_dir) + "-templates")

    write_dotenv(env, out_env)
    render_compose(prefix, egress_network, out_compose)
    copy_openclaw_templates(OPENCLAW_TMPL_DIR, templates_target)
    ensure_dir(config_dir)
    ensure_dir(workspace_dir)

    print()
    print("Next steps:")
    print(f"  1) review {out_env} and {out_compose}")
    print("  2) docker compose build")
    print("  3) docker compose up -d")
    print(
        "  4) send USER_ACCEPT_PASSWORD to your TG bot to pass the gate; "
        "openclaw will start automatically after that."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
