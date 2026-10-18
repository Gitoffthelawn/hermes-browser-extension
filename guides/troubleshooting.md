# Troubleshooting

### The side panel shows a runtime warning but still says connected

v0.3.0 introduced separate connection and runtime warnings. When a gateway answers a request with a runtime error, the Browser stays connected and shows a warning instead of labeling the gateway unreachable. Check the Hermes Agent logs for the failing dependency or component.

For tracebacks like `int() argument must be a string, a bytes-like object or a real number, not 'NoneType'`, check the Hermes Agent logs on the machine running the gateway. If the traceback mentions `computer_use` or `cua-driver`, run:

```bash
hermes computer-use doctor
```

That diagnostic belongs to the Hermes runtime/tool layer, not to Browser extension packaging or Chrome permissions.

### Profiles, skills, or voice dictation fail after a Hermes update

Current Hermes can serve profiles and skills through API routes when no dashboard is available. If those routes are missing, the extension keeps the last loaded profile details and tries the older dashboard path. It does not clear a working roster because one discovery route changed. Profiles, skills, and transcription each need their own advertised route, so a connection that loads one of them may still be missing another.

Pictures attached to a message are stored on the machine running Hermes. Reopening the session shows them when that gateway serves stored files, and the panel keeps the previews it still holds when it does not. A session that is open keeps refreshing while its reply runs; reopening it from the session list is no longer needed to see new output.

Voice dictation uses the API transcription route first, then the dashboard route, then browser speech. A dashboard that does not provide its session token is skipped. Browser speech can still fail independently when the browser has not finished installing its language pack or does not support the requested recognition mode.

### Native Hermes computer use is not working

Hermes Browser Extension does not request browser-control permissions and does not drive pages itself. Native desktop control comes from Hermes Agent's `computer_use` toolset via `cua-driver`.

On the machine running Hermes, verify computer use directly:

```bash
hermes tools list
hermes computer-use status
hermes computer-use doctor
```

If `doctor` says the driver is missing:

```bash
hermes computer-use install
```

Then start a fresh Hermes session with the toolset enabled:

```bash
hermes -t computer_use chat
```

Common blockers from the Hermes docs:

- Windows over SSH runs in Session 0 and cannot see the interactive desktop; use the console/RDP session or the cua-driver Windows autostart pattern.
- Elevated/admin windows cannot be driven by a normal-integrity Hermes process on Windows.
- macOS needs Accessibility + Screen Recording permissions.
- Linux needs a reachable X11/Wayland display and AT-SPI.

