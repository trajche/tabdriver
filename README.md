# Tab Driver

Let AI agents (Claude Code, Codex, Cursor, ...) drive **your real browser** (Arc / Chrome / Brave /
Edge / Firefox) with your existing logins and sessions, while you watch. You handle the
sensitive parts (2FA), the agent handles the tedious parts (clicking through, downloading statements).

```
agent ─stdio (MCP)─▶ tabdriver mcp ─unix socket─▶ tabdriver (host) ═browser pipe═▶ extension/ (MV3)
agent ─stdio (MCP)─▶ tabdriver mcp ─┘             launched by the browser            ├─ tabs, downloads
                                                                                       ├─ page-agent.js (content script)
                                                                                       └─ chrome.debugger (optional)
```

One static Go binary (~8 MB, no runtime) is both the MCP server and the native host.
It builds for macOS, Linux and Windows (amd64/arm64).

- **No keys or ports.** The browser launches the native host itself, and only for this extension's ID.
  Agents reach the host through a Unix socket in `~/.tabdriver/hosts/` (directory mode 700), so only
  your user account can connect. Nothing listens on the network.
- **Several agents at once.** Each agent runs its own MCP server, and all of them connect to the same host.
  The in-page banner and prompts show which agent is acting ("Codex is controlling this tab").
  Each agent keeps its own default tab.

## Setup

1. **Get the binary and register it with your browsers.** From source (Go 1.24+):
   ```sh
   make install            # builds, copies to ~/.local/bin/tabdriver, runs `tabdriver install`
   ```
   Or put a prebuilt `dist/tabdriver-<os>-<arch>` anywhere and run `tabdriver install` from there.
   The installer writes a host manifest for each installed browser (on Windows, registry keys under
   `HKCU`) pointing at the binary's current path. Run it again if you move the binary.
   `tabdriver uninstall` removes the registrations.
2. **Load the extension.**
   - *Chromium browsers:* open `chrome://extensions` in Arc/Chrome, enable *Developer mode*, click
     *Load unpacked*, and select `extension/`. The manifest's `key` gives it the fixed ID
     `lpakianppngookkeolmodlkgcgbkmooo`, which is the ID the host manifest allows.
   - *Firefox (128+):* run `make firefox`, which writes `build/firefox/` and an unsigned
     `dist/tabdriver-firefox.xpi` (add-on ID `tabdriver@firefox`). Then pick one:
     - For a quick try, open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*,
       and select `build/firefox/manifest.json`. Firefox removes it when it restarts.
     - Firefox Developer Edition, Nightly and ESR can install the unsigned `.xpi` once
       `xpinstall.signatures.required` is `false` in `about:config`: drag the `.xpi` onto a Firefox window.
     - Regular Firefox only installs signed add-ons permanently. `make firefox-sign` signs an unlisted
       (self-distributed) `.xpi` through addons.mozilla.org. It needs `WEB_EXT_API_KEY` and
       `WEB_EXT_API_SECRET` from your AMO developer account.

   The popup dot turns green once the extension reaches the native host.
3. **Add the MCP server to your agents.** The command is `tabdriver mcp`:

   | Agent | How |
   |---|---|
   | Claude Code | `claude mcp add --scope user tabdriver -- tabdriver mcp` (a project `.mcp.json` ships in this repo) |
   | Codex | `codex mcp add tabdriver -- tabdriver mcp`, then set `tool_timeout_sec = 900` under `[mcp_servers.tabdriver]` in `~/.codex/config.toml` |
   | Cursor CLI / editor | `~/.cursor/mcp.json`: `{"mcpServers":{"tabdriver":{"command":"tabdriver","args":["mcp"]}}}` |

   Running `tabdriver` with no arguments prints these lines with the binary's full path, for agents
   that don't inherit your shell's `PATH`. The agent's name comes from the MCP handshake. Set
   `TABDRIVER_AGENT_NAME` in the server's environment to override it.

## Using it

- **New tab:** "open my bank and …". The agent calls `open_tab`, and that tab becomes controlled.
- **Existing tab:** click *Let AI agents control this tab* in the popup, or the agent calls
  `request_tab_access` and you click *Allow* in the page.
- Controlled tabs show a "<Agent> is controlling this tab" pill with a **Stop** button.
  Every click and keystroke briefly highlights its target.
- **Handoff:** `wait_for_user` shows "<Agent> needs you" with a Done button. It survives redirects during login.
- The popup lists connected agents and controlled tabs. The **On** switch disconnects everything.

Example prompt:

> Open https://bank.example.com, wait for me to log in, then go to transactions, filter to August 2026,
> and download the CSV export. Tell me where the file was saved.

## Tools

| Tool | Purpose |
|---|---|
| `browser_status`, `select_browser` | Connected browsers; pick one when several are running |
| `list_tabs` | Controlled + active tabs (`all: true` for every tab) |
| `open_tab`, `close_tab`, `navigate` | Tab lifecycle, back/forward/reload |
| `request_tab_access`, `release_tab` | Ask the user for / give back an existing tab |
| `snapshot` | URL, title, text, and interactive elements as refs (`[e12] button "Export"`) |
| `click`, `type`, `select_option`, `press_key`, `scroll` | Act on refs (`trusted: true` → real input events via debugger, Chromium only) |
| `wait_for`, `get_text` | Wait for text/selector; read full text |
| `screenshot` | Visible viewport as an image |
| `evaluate` | Run JS in the page (Chromium: debugger, shows the "being debugged" bar; Firefox: page context) |
| `wait_for_user` | Hand control to you with an in-page Done/Cancel prompt |
| `list_downloads`, `wait_for_download` | Find downloaded files on disk |
| `upload_file` | Put local files on a file input, or drop them onto any element (e.g. Airtable attachment cells) |

## Security model

- The browser starts the native host only for extension IDs listed in its manifest. The host
  talks to the extension over the browser's stdio pipe.
- Agents connect through a Unix socket in `~/.tabdriver/hosts/` (directory 700, socket 600). Other users
  can't reach it, and no port is open to websites or the network. Any program running as *your* user can
  connect, the same trust level as reading your files.
- Agents can act only on tabs they opened or that you allowed. They can list tab titles and URLs.
- Page content is untrusted. A transaction description or email body could contain text aimed at the model
  (prompt injection). Watch the tab, don't approve payments or transfers through it, and use
  `wait_for_user` for confirmations.
- The `debugger` permission (Chromium only) is used only when a tool asks for `trusted` input or `evaluate`.
  The Firefox build doesn't request it.

## Notes / limits

- Large messages from the host to the extension are chunked, because Chrome caps them at 1 MB. Uploads
  are limited to 25 MB.
- `wait_for_user` can block for up to 10 minutes. Raise your agent's tool timeout (Claude Code:
  `MCP_TOOL_TIMEOUT` in ms; Codex: `tool_timeout_sec`).
- `evaluate` fails on pages where another extension has injected a frame (Chromium), or whose CSP forbids
  `eval` (Firefox). Use snapshot/click/type there.
- Firefox has no debugger API, so `trusted: true` clicks return an error there. File drops are dispatched
  from the page's own context, because Firefox hides files that a content script puts in a drag event.
- Cross-origin iframes aren't in snapshots yet (same-origin iframes and open shadow DOM are).
- `chrome://` and `about:` pages, the Chrome Web Store and addons.mozilla.org can't be scripted.
- Windows: the installer writes the registry keys, and the host uses AF_UNIX sockets (Windows 10 1803+).
  This hasn't been tested on a Windows machine yet.
- macOS: a downloaded (quarantined) binary is blocked by Gatekeeper unless it is signed and notarized.
  Building from source, or running `xattr -d com.apple.quarantine tabdriver`, avoids that.
- Host log: `~/.tabdriver/host.log`.

## Development

```
cmd/tabdriver/        entry point: install | uninstall | mcp | host (browsers launch it with no subcommand)
internal/host/         native messaging host: stdio framing, 1 MB chunking, Unix socket for agents
internal/hub/          MCP-side client: discovers hosts in ~/.tabdriver/hosts, routes calls
internal/mcpserver/    MCP tools (official Go SDK)
internal/install/      host manifests (macOS/Linux files, Windows registry)
extension/             MV3 extension (background.js, page-agent.js, popup); manifest.firefox.json for Firefox
test/e2e.mjs           browser + extension + binary, two agents, chunked upload (Chromium or --firefox)
```

```sh
make build    # bin/tabdriver
make test          # vet + gofmt + end-to-end test in Chromium (needs Node for Playwright)
make test-firefox  # same test in a throwaway Firefox profile (needs Firefox 128+; FIREFOX_BIN to override)
make firefox       # build/firefox/ and dist/tabdriver-firefox.xpi
make dist          # cross-compile to dist/
```

- After changing Go code, run `make install`, restart the agent's MCP server (Claude Code: `/mcp` →
  Reconnect), and reload the extension so the browser restarts the host.
- After changing the extension, reload it in `chrome://extensions`. For Firefox, run `make firefox` and
  click *Reload* in `about:debugging`.
- The two manifests are separate files. Keep `version` in sync; `make vet` checks it.
- `make test-firefox` temporarily replaces the per-user Firefox host manifest
  (`com.tabdriver.host.json`) and restores it afterwards, because Firefox has no per-profile location.
- Host log: `~/.tabdriver/host.log`. MCP server logs go to stderr.
