# Connection guide

## Compatibility matrix

| Surface | Supported in v0.3.4 | Fallback / note |
| --- | --- | --- |
| Chrome / Edge / Chromium 114+ side panel | Yes | Primary public support target. |
| Brave / Comet / Chromium forks | Best-effort | Must expose the Chromium Side Panel API. |
| Firefox | Install from [AMO](https://addons.mozilla.org/firefox/addon/hermes-browser-extension/) (Firefox 142+) | Chat and context only. Real-tab attach is Chromium-only; the Firefox package omits the debugger permission. |
| Safari | Not shipped | No Safari package is included. |
| Local Hermes API server | Yes | Default path: `http://127.0.0.1:8642`. |
| Hermes Cloud | Yes, Trusted Dashboard Attach | Requires an active signed-in HTTPS Hermes Cloud agent tab. Chat-only. |
| Remote API server | Yes, explicit URL/token only | Use trusted LAN/Tailscale/VPN or HTTPS reverse proxy; do not expose Hermes naked to the internet. |
| Self-hosted remote dashboard WebSocket | Best-effort | Select Remote gateway with an HTTPS dashboard URL and no API key. Chat/session/model path only. |
| Full-page Hermes Web view | Retired | The side panel is the supported browser surface. |
| Browser Context Protocol | Yes | Typed `hermes.browser.turn.v2` envelopes, with the v1 payload compatibility path. |
| Hermes Assist | Yes, site-aware preview/review | 31 writing environments. Never submits. |
| Page comments | Yes | Attach menu. Queues beside Ask Hermes. |
| Browser control | Yes (Experimental) | Opt-in MV3 controller with per-tab leases and explicit approval gates. Requires compatible Hermes Agent controller support. |
| `nativeMessaging` | No | Not requested or required. |


### Remote API server

For a remote Hermes machine, bind the API server to a reachable trusted interface and keep CORS narrow:

```bash
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=<your-api-server-key>
API_SERVER_CORS_ORIGINS=chrome-extension://<your-extension-id>
```

Use a private same-LAN/Tailscale/VPN host with HTTP, or put the API server behind a trusted HTTPS reverse proxy for public/proxied access. Do **not** expose the Hermes API server naked to the public internet. The Hermes API server can access the real Hermes runtime and tools.

Examples:

```text
http://192.168.1.50:8642
http://hermes-desktop.local:8642
https://hermes.example.com
```

In the extension side panel:

1. Choose **Remote gateway**.
2. Paste the remote API URL, including `http://` or `https://`.
3. Paste the API key/browser token.
4. Click **Test connection**.

With a key present, Remote means **Remote API server** and does not force HTTPS. With the key blank, Remote means **Remote dashboard WebSocket** and requires an `https://` dashboard URL.

### Hermes Cloud Preview

Hermes Cloud Preview uses **Trusted Dashboard Attach**:

1. Open your Hermes Cloud agent in a normal browser tab and sign in.
2. Keep that fully loaded HTTPS agent tab active.
3. Open extension Settings and choose **Hermes Cloud Preview**.
4. Click **Connect to Hermes** or **Test connection**.

The extension binds trust to that exact active tab and HTTPS origin, verifies the tab again before minting, mints a short-lived single-use WebSocket ticket in the page, and verifies the WebSocket handshake before reporting success. The ticket is kept in memory only and is never persisted or logged. Cloud never falls back to localhost or a stored Local API token.

Hermes Cloud is **Chat-only** in this release. Browser page text, selected text, open-tab context, and attachments are disabled for this mode. The extension does not read dashboard cookies, store a Cloud password, or add `cookies` or `nativeMessaging` permissions.

If the connected Cloud agent does not expose `/api/auth/ws-ticket`, `/api/ws`, or the required session/model RPC methods, the extension reports the missing capability and leaves Local/Remote settings untouched. Update that agent's Hermes runtime using the [official Hermes Agent installation and update docs](https://hermes-agent.nousresearch.com/docs/getting-started/installation). It never redirects Cloud to `127.0.0.1` as a fallback.

### Self-hosted remote dashboard mode, no API server

If you run Hermes elsewhere and only expose the OAuth-gated dashboard, select **Remote gateway**, enter the dashboard's `https://` URL, and leave the API key blank. With no key, the extension connects over the dashboard's `/api/ws` socket instead of the REST API server. This remains a Remote gateway connection; it is not automatically relabeled as Hermes Cloud.

Auth uses a single-use WebSocket ticket minted from a signed-in dashboard tab:

- Open the dashboard URL in a normal browser tab and sign in, and keep that tab around.
- The extension mints the ticket first-party from that tab, then opens the socket.
- **Test connection** opens the socket and loads models, which confirms the whole path.

Limitations in this mode: image attachments are inline-only, and the skills/profiles lists are unavailable because those are REST-only and the dashboard's REST surface is not reachable cross-origin.

