# Changelog

## 1.0.1 (2026-10-22)
- Security: API requests are refused when the Host is not one of the server's own names or addresses (DNS rebinding) or when a browser marks them cross-site. The web UI is still served to links from other pages. `allowedHosts` adds Host names; `allowCrossSite: true` restores the old open CORS behaviour.
- Security: the macOS `say` provider runs `say` without a shell and validates the voice name, closing a command injection when `macSay` is configured.
- The HTTPS server now binds `settings.ip`.
- Updated axios to 1.20.0 and follow-redirects to 1.16.1.
- Added 4 request-guard tests (42 total).

## 1.0.0 (2026-10-06)
- Added the MAX preset: hazard-marked, volume 100 applied last, blocked if any mix write fails.
- Retuned Normal (soundbar-led) and Music & Movies (heavy sub, full surrounds); presets leave volume alone.
- Added the Advanced sound panel, built from the controls each speaker reports, with fresh readback after every change.
- Added the `/{room}/mix` API; writes are validated and serialized.
- Room is selectable with `?room=`.
- Added 38 regression tests.

## 0.1.0 (2026-06-07)
- First version: one-page web UI on top of node-sonos-http-api.
