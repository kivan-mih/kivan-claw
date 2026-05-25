#!/usr/bin/env python3
"""TG password gate.

Runs before openclaw when /home/node/.openclaw/.tg_user_accepted is absent.
Long-polls Telegram getUpdates. On a message whose text matches
USER_ACCEPT_PASSWORD: replies USER_ACCEPT_WELCOME_TEXT, prepares OpenClaw
configs for that user via config_prep, writes .tg_user_accepted with the full
TG `from` dict, and exits 0 so the entrypoint can launch openclaw normally.

Mismatched messages are silently ignored (the bot does not reveal it's a gate).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import config_prep

LONG_POLL_TIMEOUT_S = 25
NET_RETRY_SLEEP_S = 2.0
ACCEPTED_FILENAME = ".tg_user_accepted"


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[gate {stamp}] {msg}", flush=True)


def require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        log(f"FATAL: env {name} is empty")
        sys.exit(2)
    return val


def tg_call(token: str, method: str, params: dict, timeout: int) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    payload = json.loads(body)
    if not payload.get("ok"):
        raise RuntimeError(f"telegram {method} failed: {payload!r}")
    return payload


def send_message(token: str, chat_id: int, text: str) -> None:
    tg_call(
        token,
        "sendMessage",
        {"chat_id": str(chat_id), "text": text},
        timeout=15,
    )


def get_updates(token: str, offset: int) -> list[dict]:
    payload = tg_call(
        token,
        "getUpdates",
        {
            "offset": str(offset),
            "timeout": str(LONG_POLL_TIMEOUT_S),
            "allowed_updates": json.dumps(["message"]),
        },
        timeout=LONG_POLL_TIMEOUT_S + 10,
    )
    return payload.get("result", [])


def write_accepted(config_dir: Path, from_dict: dict) -> None:
    target = config_dir / ACCEPTED_FILENAME
    target.write_text(
        json.dumps(from_dict, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    log(f"wrote {target}")


def main() -> int:
    token = require_env("TG_BOT_TOKEN")
    password = require_env("USER_ACCEPT_PASSWORD")
    welcome = require_env("USER_ACCEPT_WELCOME_TEXT")
    config_dir = Path(os.environ.get("OPENCLAW_CONFIG_DIR", "/home/node/.openclaw"))
    templates_dir = Path(os.environ.get("OPENCLAW_TEMPLATES_DIR", "/opt/openclaw-templates"))

    if not templates_dir.is_dir():
        log(f"FATAL: templates dir {templates_dir} not found")
        return 2
    config_dir.mkdir(parents=True, exist_ok=True)

    log(f"waiting for password match on TG bot; config_dir={config_dir}")
    offset = 0
    while True:
        # One try wraps both the network call and the per-update parse so a
        # malformed payload (KeyError/ValueError on update_id) or a non-JSON
        # response (JSONDecodeError) triggers the same retry-and-continue path
        # as a network error. urllib.error.URLError, ssl.SSLError, and
        # ConnectionResetError all subclass OSError, so OSError covers them.
        try:
            updates = get_updates(token, offset)
            for upd in updates:
                offset = max(offset, int(upd["update_id"]) + 1)
                msg = upd.get("message") or {}
                text = (msg.get("text") or "").strip()
                from_dict = msg.get("from") or {}
                chat = msg.get("chat") or {}
                if not text or not from_dict:
                    continue

                if text != password:
                    log(f"non-matching message from user_id={from_dict.get('id')!r} (ignored)")
                    continue

                log(f"password match from user_id={from_dict.get('id')!r}")
                try:
                    config_prep.prepare(
                        tg_from=from_dict,
                        templates_dir=templates_dir,
                        config_dir=config_dir,
                    )
                except Exception as e:
                    log(f"FATAL: config_prep failed: {e}")
                    return 3

                try:
                    send_message(token, chat["id"], welcome)
                except Exception as e:
                    log(f"send_message failed (continuing): {e}")

                write_accepted(config_dir, from_dict)
                log("gate passed; handing off to openclaw")
                return 0
        except (OSError, TimeoutError, RuntimeError, json.JSONDecodeError, ValueError, KeyError) as e:
            log(f"poll error: {type(e).__name__}: {e}; retrying in {NET_RETRY_SLEEP_S}s")
            time.sleep(NET_RETRY_SLEEP_S)
            continue


if __name__ == "__main__":
    sys.exit(main())
