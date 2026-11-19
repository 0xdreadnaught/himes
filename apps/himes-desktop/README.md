# Himes desktop (early build)

This is the first Wails client in the Himes fork. It currently connects to the
existing Hermes Python gateway. It does not replace the installed Hermes
Desktop app or modify its configuration. The Go process owns a WebSocket
connection; React renders the desktop interface. See the repository's
[`FORK.md`](../../FORK.md) for the independent-runtime boundary.

## Present scope

- Connect locally with one click. The Go process runs the installed Hermes
  CLI's `gateway attach --start --json`, uses the one-use ticket immediately,
  and keeps it out of the UI and logs.
- Connect to a remote HTTPS gateway with an optional in-memory token under
  the advanced connection option.
- Create or reopen a session, submit a prompt, and display streaming replies.
- List models and request a canonical, revision-fenced provider/model switch.
  The UI distinguishes the active route from a queued switch and requests
  confirmation when the gateway requires it.
- Ask the agent to delegate a bounded task to a named route and show subagent
  activity. Delegation itself is an agent tool, not a direct gateway RPC.

## Build on Windows

Requires Go 1.26+, Node, and npm. Run `./build-windows.ps1` from this directory;
it installs the pinned frontend packages, builds the frontend, runs Go tests and
vet, and writes `bin/himes-desktop.exe`. It does not launch or install the app.

```powershell
./build-windows.ps1
```

The binary embeds the built frontend. The Python runtime is not bundled.

## Limits of this prototype

- Streaming handles basic message start, delta, and completion events. It does
  not yet replay missed events after reconnect, render all tool/interim events,
  or handle server-initiated approval, clarification, secret, and sudo requests.
- The client does not claim server-request capability to the gateway. Tasks
  requiring interactive requests may fail rather than prompt in this UI.
- Credentials are held in process memory and are not persisted. This is not a
  complete account-management or onboarding flow.
- Packaging, signing, updates, macOS/Linux builds, and accessible UI review
  have not been completed.
- The binary's size alone is not a fair comparison with Hermes Desktop; the
  latter can bundle a Python runtime. Compare equivalent deployments and
  measure idle/active memory and startup on the same machine before choosing
  a client architecture.
