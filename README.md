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

1. **Binary** (Go 1.24+):
   ```sh
   make install   # builds ~/.local/bin/tabdriver and registers it with your browsers
   ```
2. **Extension**
   - Chrome, Arc, Brave, Edge: `chrome://extensions` → *Developer mode* → *Load unpacked* → `extension/`
   - Firefox 128+: `make firefox`, then load `build/firefox/manifest.json` in
     `about:debugging#/runtime/this-firefox`, or install `dist/tabdriver-firefox.xpi` (unsigned: Developer
     Edition, Nightly, ESR; `make firefox-sign` signs it for regular Firefox)
3. **Agent**
   ```sh
   claude mcp add --scope user tabdriver -- tabdriver mcp
   codex mcp add tabdriver -- tabdriver mcp
   ```
   Run `tabdriver` without arguments to print the config for other agents.

The popup dot turns green when the extension reaches the host.

## Use

> Open https://bank.example.com, wait for me to log in, then download the August transactions as CSV.

- Agents act only on tabs they opened or that you allowed (popup, or *Allow* in the page).
- Controlled tabs show "*Agent* is controlling this tab" with a **Stop** button.
- `wait_for_user` hands the tab to you and waits for *Done*. Raise your agent's tool timeout for it
  (Claude Code `MCP_TOOL_TIMEOUT`, Codex `tool_timeout_sec`).
- Several agents can work at once, each in its own tabs.
- With [Arcsidebar](https://github.com/trajche/arc) in Firefox, controlled tabs get an **AI** badge in the sidebar.

## Tools

`browser_status` `select_browser` `list_tabs` `open_tab` `close_tab` `navigate` `request_tab_access`
`release_tab` `snapshot` `click` `type` `select_option` `press_key` `scroll` `wait_for` `get_text`
`screenshot` `evaluate` `wait_for_user` `list_downloads` `wait_for_download` `upload_file`

## Security

- The browser launches the host only for this extension. Agents reach it through a Unix socket in
  `~/.tabdriver/hosts/` that only your user can open.
- Page content is untrusted and may try to instruct the agent. Watch the tab, and don't let an agent
  approve payments.
- Chromium's `debugger` permission is used only for `evaluate` and `trusted` clicks. Firefox has no
  debugger, so there `evaluate` runs in the page and `trusted` clicks aren't available.

## Development

```sh
make build          # bin/tabdriver
make test           # vet + end-to-end test in Chromium (needs Node)
make test-firefox   # same in a throwaway Firefox profile
make firefox        # build/firefox/ and dist/tabdriver-firefox.xpi
make dist           # release binaries for macOS, Linux, Windows
```

Logs: `~/.tabdriver/host.log` (host), stderr (MCP server).
