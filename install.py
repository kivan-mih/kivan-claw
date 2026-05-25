#!/usr/bin/env python3
"""OpenClaw kastomny installer.

Reads a JSON config and emits:
  - .env (in CWD) with the env vars the user listed
  - docker-compose.yml (in CWD) from templates/docker-compose.yml.tmpl
  - copies templates/openclaw-config/ to ${OPENCLAW_CONFIG_DIR}-templates/
  - mkdirs ${OPENCLAW_CONFIG_DIR} and its ./workspace subdir

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = REPO_ROOT / "templates"
COMPOSE_TMPL = TEMPLATES_DIR / "docker-compose.yml.tmpl"
OPENCLAW_TMPL_DIR = TEMPLATES_DIR / "openclaw-config"

PROXY_REMOTE = "git@github.com:kivan-mih/cp-oclaw-proxy.git"
PROXY_DIR_NAME = "cp-openclaw-proxy"

ENV_KEYS = (
    "TG_BOT_TOKEN",
    "ZAI_TOKEN",
    "BRAVE_SEARCH_TOKEN",
    "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_BIND",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_BRIDGE_PORT",
    "USER_ACCEPT_PASSWORD",
    "USER_ACCEPT_WELCOME_TEXT",
    "PROXY_TELEGRAM_USER_ID",
    "PROXY_VIRUSTOTAL_API_KEY",
    "PROXY_URLHAUS_AUTH_KEY",
    "PROXY_WEB_RISK_API_KEY",
)

REQUIRED_NONEMPTY = (
    "TG_BOT_TOKEN",
    "ZAI_TOKEN",
    "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_GATEWAY_BIND",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_BRIDGE_PORT",
    "USER_ACCEPT_PASSWORD",
    "USER_ACCEPT_WELCOME_TEXT",
    "PROXY_TELEGRAM_USER_ID",
)

# Values that need quoting in .env when written; matches characters that
# Docker Compose v2 dotenv interprets specially or that complicate parsing.
# Includes '\n' and '\r' so multi-line values force quoting (and get escaped
# below) instead of breaking the .env file structure across lines.
DOTENV_NEEDS_QUOTE = set(" \t\"'#$\\=()\n\r")


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
        # Docker Compose v2 interpolates $VAR / ${VAR} inside double-quoted
        # env_file values, so '$' must be escaped to '\$' or the rest of the
        # value gets eaten as a variable name. Newlines and carriage returns
        # must be escaped too — otherwise the .env structure splits across
        # lines and downstream parsers break.
        escaped = (
            value.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("$", "\\$")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        )
        return f'"{escaped}"'
    return value


def write_dotenv(env: dict[str, str], dest: Path) -> None:
    lines = []
    for key in ENV_KEYS:
        raw = env.get(key, "")
        lines.append(f"{key}={quote_dotenv(raw)}")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {dest}")


def render_compose(prefix: str, dest: Path) -> None:
    if not COMPOSE_TMPL.is_file():
        die(f"missing template: {COMPOSE_TMPL}")
    text = COMPOSE_TMPL.read_text(encoding="utf-8")
    text = text.replace("@@PREFIX@@", prefix)
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


def clone_proxy_repo(target: Path) -> None:
    """Fresh-clone the proxy sidecar repo into target.

    Always-fresh per spec: wipe the directory first, then clone. git clone
    refuses to write into a non-empty dir, so rmtree is mandatory when the
    placeholder folder already exists. Any failure (git missing, auth, network)
    aborts install before we touch the compose/.env files.
    """
    if target.exists():
        shutil.rmtree(target)
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", PROXY_REMOTE, str(target)],
            check=True,
        )
    except FileNotFoundError:
        die("git is not installed or not on PATH; cannot clone proxy repo")
    except subprocess.CalledProcessError as e:
        die(f"failed to clone proxy repo {PROXY_REMOTE} (exit {e.returncode})")
    print(f"cloned {PROXY_REMOTE} -> {target}")


def patch_gateway_port(templates_target: Path, port: int) -> None:
    """Sync openclaw.json's gateway port with OPENCLAW_GATEWAY_PORT.

    The compose template interpolates OPENCLAW_GATEWAY_PORT into the host
    mapping, the --port arg, and the healthcheck URL. The matching
    in-container references (gateway.port and gateway.remote.url) live in
    openclaw.json, which config_prep renders at runtime — but config_prep
    only substitutes TG user data, not env vars. install.py runs outside
    the container with full env in hand, so patch the copied template here.
    """
    cfg_path = templates_target / "openclaw.json"
    if not cfg_path.is_file():
        return
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    gw = data.get("gateway")
    if isinstance(gw, dict):
        gw["port"] = port
        remote = gw.get("remote")
        if isinstance(remote, dict) and isinstance(remote.get("url"), str):
            # Replace `:<port>` at the end (or before path/query/fragment).
            remote["url"] = re.sub(
                r":\d+(?=[/?#]|$)", f":{port}", remote["url"]
            )
    cfg_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"patched {cfg_path}: gateway.port={port}")


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

    try:
        gateway_port = int(env["OPENCLAW_GATEWAY_PORT"])
    except ValueError:
        die(f"OPENCLAW_GATEWAY_PORT must be an integer; got {env['OPENCLAW_GATEWAY_PORT']!r}")
    if not (1 <= gateway_port <= 65535):
        die(f"OPENCLAW_GATEWAY_PORT must be in 1..65535; got {gateway_port}")

    if not env["OPENCLAW_GATEWAY_TOKEN"]:
        env["OPENCLAW_GATEWAY_TOKEN"] = secrets.token_hex(32)
        print("OPENCLAW_GATEWAY_TOKEN was empty; generated a fresh 64-hex token")

    out_env = args.cwd / ".env"
    out_compose = args.cwd / "docker-compose.yml"
    config_dir = Path(env["OPENCLAW_CONFIG_DIR"]).expanduser()
    # Normalise the env value back to its canonical Path string so compose's
    # raw '${OPENCLAW_CONFIG_DIR}-templates' interpolation and our host-side
    # write target agree — otherwise a user trailing slash makes the two paths
    # diverge (install.py writes to '/x-templates', compose mounts '/x/-templates').
    env["OPENCLAW_CONFIG_DIR"] = str(config_dir)
    templates_target = config_dir.parent / (config_dir.name + "-templates")
    # Workspace lives under config_dir as a subfolder; the gateway's config bind
    # mount covers it automatically, so no separate volume mount is needed.
    workspace_dir = config_dir / "workspace"

    # Clone the proxy sidecar repo first. If this fails, abort before writing
    # any compose/env files so the install dir stays in its pre-run state and
    # the user can fix auth/network and rerun cleanly.
    clone_proxy_repo(args.cwd / PROXY_DIR_NAME)

    write_dotenv(env, out_env)
    render_compose(prefix, out_compose)
    copy_openclaw_templates(OPENCLAW_TMPL_DIR, templates_target)
    patch_gateway_port(templates_target, gateway_port)
    ensure_dir(config_dir)
    ensure_dir(workspace_dir)

    # Compose mounts './.gitconfig:/home/node/.gitconfig:ro'. If the file is
    # absent at compose-up time, Docker creates an empty *directory* at the
    # source and bind-mounts a directory over a file path inside the container,
    # which breaks every git invocation. Touching an empty file here keeps the
    # mount valid; the operator can fill in [user] / [core] entries afterward.
    gitconfig = args.cwd / ".gitconfig"
    if not gitconfig.exists():
        gitconfig.touch()
        print(f"created empty {gitconfig} (add your own [user] block if needed)")

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
