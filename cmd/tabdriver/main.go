// Command tabdriver lets AI agents control your real browser through the
// Tab Driver extension.
//
//	tabdriver install     register the native host with installed browsers
//	tabdriver uninstall   remove the registration
//	tabdriver mcp         run the MCP server (configure this in your agent)
//	tabdriver host        run the native host (browsers launch this themselves)
package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/trajche/tabdriver/internal/common"
	"github.com/trajche/tabdriver/internal/host"
	"github.com/trajche/tabdriver/internal/install"
	"github.com/trajche/tabdriver/internal/mcpserver"
)

const usage = `tabdriver %s: let AI agents control your real browser.

Usage:
  tabdriver install [--extension-id ID]...   register with installed browsers
  tabdriver uninstall                        remove the registration
  tabdriver mcp                              MCP server for your agent (stdio)
  tabdriver host                             native host (launched by the browser)
  tabdriver version

Agent setup:
  Claude Code  claude mcp add --scope user tabdriver -- %[2]s mcp
  Codex        codex mcp add tabdriver -- %[2]s mcp
  Cursor       ~/.cursor/mcp.json: {"mcpServers":{"tabdriver":{"command":"%[2]s","args":["mcp"]}}}
`

func main() {
	args := os.Args[1:]
	// Browsers launch the host with no subcommand: Chromium passes the caller's
	// origin (chrome-extension://id/), Firefox the manifest path and extension id.
	if len(args) > 0 && (strings.HasPrefix(args[0], "chrome-extension://") || strings.HasSuffix(args[0], ".json")) {
		args = []string{"host"}
	}
	if len(args) == 0 {
		exe, _ := os.Executable()
		fmt.Printf(usage, common.Version, exe)
		return
	}

	var err error
	switch args[0] {
	case "install":
		var ids []string
		for i := 1; i < len(args)-1; i++ {
			if args[i] == "--extension-id" {
				ids = append(ids, args[i+1])
			}
		}
		err = install.Install(ids)
	case "uninstall":
		err = install.Uninstall()
	case "mcp":
		err = mcpserver.Run(context.Background())
	case "host":
		err = host.Run()
	case "version", "--version", "-v":
		fmt.Println(common.Version)
	case "help", "--help", "-h":
		exe, _ := os.Executable()
		fmt.Printf(usage, common.Version, exe)
	default:
		err = fmt.Errorf("unknown command %q (run tabdriver --help)", args[0])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tabdriver:", err)
		os.Exit(1)
	}
}
