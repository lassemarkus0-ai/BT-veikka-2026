"""
liiga_common.py

Shared helpers for the update_*.py scripts: talking to the Liiga API
with retries, figuring out the current season, and writing JSON files
atomically so an interrupted run can't corrupt data on disk.
"""

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date

API_ROOT = "https://liiga.fi/api/v2"

FETCH_ATTEMPTS = 3
FETCH_BACKOFF_SECONDS = 3


def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    print(f"WARNING: {msg}", file=sys.stderr, flush=True)


def current_season() -> int:
    """
    Liiga seasons are named after the year they END in (the 2026-2027
    season is season=2027). Play runs roughly September -> spring, so:
      Aug-Dec -> next calendar year;  Jan-Jul -> this calendar year.
    """
    today = date.today()
    return today.year + 1 if today.month >= 8 else today.year


def fetch_json(path: str, *, params: dict | None = None):
    """
    GET a Liiga API path (relative to API_ROOT) with retries, and
    return the parsed JSON body. Exits the process on final failure.
    """
    url = f"{API_ROOT}{path}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "karpat-bet-site/1.0"})

    last_error = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
            return json.loads(raw)
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            last_error = e
            if attempt < FETCH_ATTEMPTS:
                wait = FETCH_BACKOFF_SECONDS * attempt
                warn(f"Fetch attempt {attempt}/{FETCH_ATTEMPTS} failed ({e}); retrying in {wait}s")
                time.sleep(wait)

    print(f"ERROR: could not fetch {url}: {last_error}", file=sys.stderr)
    sys.exit(1)


def write_json_atomic(path: str, data: dict) -> None:
    """Write via a temp file + rename so an interrupted run can't corrupt the file."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".data-", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
