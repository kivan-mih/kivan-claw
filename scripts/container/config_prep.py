#!/usr/bin/env python3
"""Prepare OpenClaw configs for a freshly-paired TG user.

Reads templates from /opt/openclaw-templates/ (read-only mount), substitutes
@@TG_USER_ID@@ / @@TG_USERNAME@@ / @@TG_FIRST_NAME@@ / @@TG_LAST_NAME@@ with
the actual TG user's data, and writes the result into OPENCLAW_CONFIG_DIR.

Existing files in OPENCLAW_CONFIG_DIR are overwritten — this is the first-run
bootstrap and there's nothing user-edited to preserve yet.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

PLACEHOLDER_KEYS = {
    "@@TG_USER_ID@@": "id",
    "@@TG_USERNAME@@": "username",
    "@@TG_FIRST_NAME@@": "first_name",
    "@@TG_LAST_NAME@@": "last_name",
}


def _json_escape_inner(s: str) -> str:
    # json.dumps wraps in quotes; strip them to splice into a placeholder slot.
    return json.dumps(s, ensure_ascii=False)[1:-1]


def _build_substitutions(tg_from: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for placeholder, key in PLACEHOLDER_KEYS.items():
        raw = tg_from.get(key, "")
        if raw is None:
            raw = ""
        out[placeholder] = _json_escape_inner(str(raw))
    return out


def _substitute(text: str, subs: dict[str, str]) -> str:
    for k, v in subs.items():
        text = text.replace(k, v)
    return text


def _copy_with_subs(src: Path, dst: Path, subs: dict[str, str]) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix == ".json":
        text = src.read_text(encoding="utf-8")
        rendered = _substitute(text, subs)
        json.loads(rendered)  # validate
        dst.write_text(rendered, encoding="utf-8")
    else:
        shutil.copy2(src, dst)


def prepare(tg_from: dict, templates_dir: Path, config_dir: Path) -> None:
    if not templates_dir.is_dir():
        raise FileNotFoundError(f"templates dir not found: {templates_dir}")
    config_dir.mkdir(parents=True, exist_ok=True)

    subs = _build_substitutions(tg_from)

    rendered: list[Path] = []
    for src in templates_dir.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(templates_dir)
        dst = config_dir / rel
        _copy_with_subs(src, dst, subs)
        rendered.append(dst)

    print(
        f"[config_prep] rendered {len(rendered)} files into {config_dir}",
        flush=True,
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: config_prep.py <tg_from_json>", file=sys.stderr)
        return 2
    tg_from = json.loads(argv[1])
    templates_dir = Path(os.environ.get("OPENCLAW_TEMPLATES_DIR", "/opt/openclaw-templates"))
    config_dir = Path(os.environ.get("OPENCLAW_CONFIG_DIR", "/home/node/.openclaw"))
    prepare(tg_from, templates_dir, config_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
