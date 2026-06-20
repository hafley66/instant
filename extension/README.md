# instant spy (Chrome extension)

Streams browser activity into the `instant` app's **Spy** panel:

- **nav** — every completed top-level page load (url + title)
- **selection** — debounced text selections longer than 8 chars
- **clipboard** — anything you copy (the `copy` event's selection)

## How it connects

The extension POSTs JSON to `http://127.0.0.1:8787/ingest`, the localhost
endpoint the app runs while open. The app writes each event into a SQLite ring
(`<app_data_dir>/spy.db`) that keeps the last **7 days**, and the Spy panel
updates live. Click a row to paste its text/url into the active terminal.

Only the background service worker talks to localhost (`host_permissions`); the
content script relays through it, since an https page can't fetch http-localhost
directly.

## Load it

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` folder.

Events only land while the `instant` app is running (the server lives in the
app). If the app is closed the POST silently fails; nothing is queued.

## Test the endpoint without the browser

```sh
curl -s -XPOST http://127.0.0.1:8787/ingest \
  -H 'content-type: application/json' \
  -d '{"kind":"nav","url":"https://example.com","title":"Example","text":""}'
```
