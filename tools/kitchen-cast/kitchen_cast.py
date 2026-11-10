#!/usr/bin/env python3
"""Keep KiddoDash's kitchen screen (/kiosk) up on a Nest Hub at the right times.

During the cast windows (default 06:30-08:30 and 15:00-20:00), on days the kids
are home (KiddoDash's /api/schedule, i.e. the custody setting), it casts the
kiosk page whenever the Hub is sitting idle on its ambient screen. It never
interrupts anything else (music, video): once that ends and the Hub goes idle,
the board comes back. If someone closes the board, it waits COOLDOWN_MIN before
putting it back. When a window ends it closes the board, so the Hub returns to
its clock; a board cast by hand outside the windows is left alone.

Needs pychromecast (e.g. the venv `pipx install catt` makes). Configured by env:
  HUB_HOST       Hub IP address (required)
  KIOSK_URL      full kiosk link incl. ?key= (required; Settings -> Access)
  SCHEDULE_URL   default http://localhost:8321/api/schedule
  CAST_WINDOWS   default "06:30-08:30,15:00-20:00"
  COOLDOWN_MIN   default 15
  POLL_SEC       default 30
"""

import json
import logging
import os
import sys
import time
import urllib.request
from datetime import datetime, time as dtime

import pychromecast
from pychromecast.config import APP_DASHCAST
from pychromecast.controllers.dashcast import DashCastController

log = logging.getLogger("kitchen-cast")


def parse_windows(spec):
    windows = []
    for part in spec.split(","):
        start, end = (dtime.fromisoformat(t.strip()) for t in part.split("-"))
        windows.append((start, end))
    return windows


def kids_home(schedule_url, day):
    """True/False from KiddoDash, or None if it can't be reached."""
    try:
        with urllib.request.urlopen(f"{schedule_url}?date={day.isoformat()}", timeout=5) as r:
            return bool(json.load(r)["home"])
    except Exception as e:  # noqa: BLE001 - any failure just means "don't know"
        log.warning("schedule check failed: %s", e)
        return None


def main():
    host = os.environ["HUB_HOST"]
    kiosk_url = os.environ["KIOSK_URL"]
    schedule_url = os.environ.get("SCHEDULE_URL", "http://localhost:8321/api/schedule")
    windows = parse_windows(os.environ.get("CAST_WINDOWS", "06:30-08:30,15:00-20:00"))
    cooldown = float(os.environ.get("COOLDOWN_MIN", "15")) * 60
    poll = float(os.environ.get("POLL_SEC", "30"))

    cast = pychromecast.get_chromecast_from_host((host, 8009, None, None, None), tries=None, retry_wait=10)
    cast.wait()
    dash = DashCastController()
    cast.register_handler(dash)
    log.info("connected to %s (%s); windows %s", cast.cast_info.friendly_name, host,
             ", ".join(f"{a:%H:%M}-{b:%H:%M}" for a, b in windows))

    was_wanted = False   # previous tick was inside a window on a home day
    saw_ours = False     # previous tick showed our board
    dismissed_at = None  # when the board was last closed by someone (or the Hub)
    home = None          # kids here today? re-asked every few minutes
    home_checked = (None, 0.0)  # (date, monotonic time) of the last ask
    busy_with = None     # the other app we last logged leaving alone

    while True:
        now = datetime.now()
        today = now.date()
        in_window = any(a <= now.time() < b for a, b in windows)
        # Re-ask now and then, so a same-day change in Settings is picked up.
        if in_window and (home_checked[0] != today or time.monotonic() - home_checked[1] > 600):
            answer = kids_home(schedule_url, today)
            if answer is not None:
                if answer != home:
                    log.info("kids are %s today", "home" if answer else "away")
                home, home_checked = answer, (today, time.monotonic())
        wanted = in_window and home_checked[0] == today and bool(home)

        status = cast.status
        app = status.app_id if status else None
        ours = app == APP_DASHCAST

        if wanted:
            if ours:
                busy_with = None
            elif cast.is_idle:
                busy_with = None
                if saw_ours:
                    dismissed_at = time.monotonic()
                    log.info("board was closed; waiting %d min before recasting", cooldown // 60)
                if dismissed_at is None or time.monotonic() - dismissed_at >= cooldown:
                    log.info("hub idle: casting the board")
                    dash.load_url(kiosk_url, force=True)
                    dismissed_at = None
            else:
                name = status.display_name or app
                if name != busy_with:
                    log.info("hub busy with %s: leaving it alone", name)
                busy_with = name
        elif was_wanted:
            if ours:
                log.info("window over: closing the board")
                cast.quit_app()
            dismissed_at = None
            ours = False

        saw_ours = ours
        was_wanted = wanted
        time.sleep(poll)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stdout)
    logging.getLogger("pychromecast").setLevel(logging.WARNING)
    main()
