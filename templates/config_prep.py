#!/usr/bin/env python3
"""Prepare OpenClaw configs for a freshly-paired TG user.

Reads templates from /opt/openclaw-templates/ (read-only mount), substitutes
@@TG_*@@ placeholders with the actual TG user's data, and writes the result
into OPENCLAW_CONFIG_DIR.

Substitution applies to .json (JSON-escaped + validated) and .md (raw plain
text) files; any other extension is copied verbatim via shutil.copy2.

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
    "@@TG_LANGUAGE_CODE@@": "language_code",
}


def _json_escape_inner(s: str) -> str:
    # json.dumps wraps in quotes; strip them to splice into a placeholder slot.
    return json.dumps(s, ensure_ascii=False)[1:-1]


def _build_substitutions(tg_from: dict) -> tuple[dict[str, str], dict[str, str]]:
    """Return (json_subs, plain_subs) — same keys, different escaping.

    json_subs values are escaped for splicing into JSON string slots.
    plain_subs values are raw strings for splicing into markdown / plain text.
    Derived placeholders (@@TG_FULL_NAME@@, @@TG_HANDLE@@) are computed once
    here so the markdown stays clean when TG omits last_name/username.
    """
    raw: dict[str, str] = {}
    for placeholder, key in PLACEHOLDER_KEYS.items():
        v = tg_from.get(key, "")
        if v is None:
            v = ""
        raw[placeholder] = str(v)

    first = raw["@@TG_FIRST_NAME@@"]
    last = raw["@@TG_LAST_NAME@@"]
    raw["@@TG_FULL_NAME@@"] = (first + " " + last).strip()
    username = raw["@@TG_USERNAME@@"]
    raw["@@TG_HANDLE@@"] = f"@{username}" if username else "(none)"

    json_subs = {k: _json_escape_inner(v) for k, v in raw.items()}
    plain_subs = raw
    return json_subs, plain_subs


def _substitute(text: str, subs: dict[str, str]) -> str:
    for k, v in subs.items():
        text = text.replace(k, v)
    return text


def _copy_with_subs(
    src: Path, dst: Path, json_subs: dict[str, str], plain_subs: dict[str, str]
) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix == ".json":
        text = src.read_text(encoding="utf-8")
        rendered = _substitute(text, json_subs)
        json.loads(rendered)  # validate
        dst.write_text(rendered, encoding="utf-8")
    elif src.suffix == ".md":
        text = src.read_text(encoding="utf-8")
        rendered = _substitute(text, plain_subs)
        dst.write_text(rendered, encoding="utf-8")
    else:
        shutil.copy2(src, dst)


def prepare(tg_from: dict, templates_dir: Path, config_dir: Path) -> None:
    if not templates_dir.is_dir():
        raise FileNotFoundError(f"templates dir not found: {templates_dir}")
    config_dir.mkdir(parents=True, exist_ok=True)

    json_subs, plain_subs = _build_substitutions(tg_from)

    rendered: list[Path] = []
    for src in templates_dir.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(templates_dir)
        dst = config_dir / rel
        _copy_with_subs(src, dst, json_subs, plain_subs)
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
