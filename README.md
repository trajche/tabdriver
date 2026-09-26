<p align="center">
  <img src="docs/logo.png" alt="" width="128" height="128">
</p>

<h1 align="center">Tab Driver</h1>

<p align="center">Let AI agents drive your real browser, with your logins, while you watch.</p>

Claude Code, Codex, Cursor and other MCP agents open tabs, read pages, click, type, upload and
download in Chrome, Arc, Brave, Edge or Firefox. You step in for logins and 2FA; they do the clicking.

```
agent ─MCP─▶ tabdriver mcp ─unix socket─▶ tabdriver (native host) ─▶ browser extension
```

One Go binary is both the MCP server and the native messaging host. No ports, no API keys.

## Install

**1. App**

```sh
# macOS
brew tap trajche/tabdriver https://github.com/trajche/tabdriver && brew trust trajche/tabdriver && brew install tabdriver

# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/trajche/tabdriver/main/install.sh | sh
```
```powershell
# Windows
irm https://raw.githubusercontent.com/trajche/tabdriver/main/install.ps1 | iex
# or: scoop bucket add tabdriver https://github.com/trajche/tabdriver; scoop install tabdriver
```

Each of these registers the app with your browsers. Or download it directly:
[macOS arm64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_darwin_arm64.tar.gz) ·
[macOS x64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_darwin_amd64.tar.gz) ·
[Linux x64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_linux_amd64.tar.gz) ·
[Linux arm64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_linux_arm64.tar.gz) ·
[Windows x64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_windows_amd64.zip) ·
[Windows arm64](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver_windows_arm64.zip),
then run `tabdriver install`.

**2. Extension**

- Firefox 142+: open [tabdriver-firefox.xpi](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver-firefox.xpi) in Firefox (signed by Mozilla, updates itself)
- Chrome, Arc, Brave, Edge: unzip [tabdriver-chrome.zip](https://github.com/trajche/tabdriver/releases/latest/download/tabdriver-chrome.zip),
  then `chrome://extensions` → *Developer mode* → *Load unpacked*

The popup dot turns green when the extension reaches the app.

**3. Agent**

```sh
claude mcp add --scope user tabdriver -- tabdriver mcp
codex mcp add tabdriver -- tabdriver mcp
```

Run `tabdriver` without arguments to print the config for other agents.

## Use

> Open https://bank.example.com, wait for me to log in, then download the August transactions as CSV.

- Agents act only on tabs they opened or that you allowed (popup, or *Allow* in the page).
- Controlled tabs show "*Agent* is controlling this tab" with a **Stop** button.
  The agent's pointer glides to everything it clicks or types into, so you can follow along
  (switch it off in the popup).
- `wait_for_user` hands the tab to you and waits for *Done*. Raise your agent's tool timeout for it
  (Claude Code `MCP_TOOL_TIMEOUT`, Codex `tool_timeout_sec`).
- Several agents can work at once, each in its own tabs.
- With [Arcsidebar](https://github.com/trajche/arc) in Firefox, controlled tabs show a robot in the sidebar
  (blinking while the agent works), and right-clicking a tab lets agents take it or stops them.

## Tools

`browser_status` `select_browser` `list_tabs` `open_tab` `close_tab` `navigate` `request_tab_access`
`release_tab` `snapshot` `click` `type` `select_option` `press_key` `scroll` `wait_for` `get_text`
`screenshot` (`path`, `annotate`) `console` `errors` `evaluate` `wait_for_user` `list_downloads`
`wait_for_download` `upload_file` `dogfood_guide`

## Dogfood

Exploratory QA of a web app in your own browser: the agent uses it like a user, logs bugs and UX
problems, and writes a report with annotated screenshots and console errors for every issue.
In Claude Code, run `/mcp__tabdriver__dogfood https://app.example.com`; other agents: "dogfood
app.example.com" (they call `dogfood_guide`). The report goes to `./dogfood-output/`. The agent hands
you logins and 2FA, and doesn't pay, delete or send anything.

## Security

- The browser launches the host only for this extension. Agents reach it through a Unix socket in
  `~/.tabdriver/hosts/` that only your user can open.
- Page content is untrusted and may try to instruct the agent. Watch the tab, and don't let an agent
  approve payments.
- Chromium's `debugger` permission is used only for `evaluate` and `trusted` clicks. Neither exists
  in Firefox.

## Development

```sh
make install        # build from source (Go) into ~/.local/bin and register it
make test           # vet + end-to-end test in Chromium (needs Node)
make test-firefox   # same in a throwaway Firefox profile
make firefox chrome # extension packages in build/ (make firefox-sign: signed .xpi)
make snapshot       # local release build with GoReleaser, publishes nothing
```

Release: push a tag like `v0.3.0`. The workflow builds all binaries, publishes the GitHub release,
updates the Homebrew cask and Scoop manifest, and signs the Firefox add-on with Mozilla (unlisted,
so it isn't in the AMO catalogue) for `updates.json`.

Logs: `~/.tabdriver/host.log` (host), stderr (MCP server).

## License

MIT
