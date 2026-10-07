# Changelog

## 1.0.0 (2026-10-06)
- Added the MAX preset: hazard-marked, volume 100 applied last, blocked if any mix write fails.
- Retuned Normal (soundbar-led) and Music & Movies (heavy sub, full surrounds); presets leave volume alone.
- Added the Advanced sound panel, built from the controls each speaker reports, with fresh readback after every change.
- Added the `/{room}/mix` API; writes are validated and serialized.
- Room is selectable with `?room=`.
- Added 38 regression tests.

## 0.1.0 (2026-06-07)
- First version: one-page web UI on top of node-sonos-http-api.
