# Kitchen screen caster

Keeps KiddoDash's kitchen screen (`/kiosk`) up on a Nest Hub:

- **When:** during the cast windows (default 6:30–8:30am and 3–8pm), and only on
  days the kids are home, using the custody setting via `GET /api/schedule`.
- **Idle only:** it casts only when the Hub is idle on its ambient screen. It never
  interrupts music or video; once those end, the board comes back.
- **Closed by someone:** it waits 15 minutes before putting the board back.
- **Window end:** it closes the board so the Hub goes back to its clock. A board
  cast by hand outside the windows is left alone.

## Install (Raspberry Pi, as your user)

```sh
pipx install catt   # provides pychromecast (and `catt` for casting by hand)
mkdir -p ~/.config/kiddodash
cat > ~/.config/kiddodash/kitchen-cast.env <<ENV
HUB_HOST=192.168.50.181
KIOSK_URL=http://192.168.50.200:8321/kiosk?key=<key from Settings → Access → Kitchen screen>
# CAST_WINDOWS=06:30-08:30,15:00-20:00
# COOLDOWN_MIN=15
ENV
chmod 600 ~/.config/kiddodash/kitchen-cast.env
ln -sf ~/Projects/kiddodash/tools/kitchen-cast/kitchen-cast.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now kitchen-cast
journalctl --user -u kitchen-cast -f   # watch what it does
```

Change the env file, then `systemctl --user restart kitchen-cast`.
