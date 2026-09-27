// Package common holds constants and helpers shared by the native host, the
// MCP server and the installer.
package common

import (
	"os"
	"os/user"
	"path/filepath"
	"regexp"
)

const (
	HostName           = "com.tabdriver.host"
	ExtensionID        = "lpakianppngookkeolmodlkgcgbkmooo"
	FirefoxExtensionID = "tabdriver@firefox"
)

// Version is set at build time with -ldflags "-X .../common.Version=v1.2.3".
var Version = "dev"

// Protocol is the version of the host <-> extension messages. Bump it only when the extension
// needs something older apps don't do; the extension asks users to update below its minimum.
const Protocol = 1

// BaseDir is ~/.tabdriver (overridable with TABDRIVER_HOME, used by tests).
func BaseDir() string {
	if d := os.Getenv("TABDRIVER_HOME"); d != "" {
		return d
	}
	home := HomeDir()
	if home == "" {
		home = os.TempDir()
	}
	return filepath.Join(home, ".tabdriver")
}

// HomeDir is the user's real home directory, from the user database rather than $HOME.
// Homebrew runs cask install steps with HOME pointing into its sandbox, but browsers read
// their host registrations from the real home.
func HomeDir() string {
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	home, _ := os.UserHomeDir()
	return home
}

// HostsDir holds one Unix socket per running native host (one per browser).
func HostsDir() string { return filepath.Join(BaseDir(), "hosts") }

var agentPatterns = []struct {
	re    *regexp.Regexp
	label string
}{
	{regexp.MustCompile(`(?i)claude`), "Claude"},
	{regexp.MustCompile(`(?i)codex|openai`), "Codex"},
	{regexp.MustCompile(`(?i)cursor`), "Cursor"},
	{regexp.MustCompile(`(?i)grok|xai`), "Grok"},
	{regexp.MustCompile(`(?i)gemini`), "Gemini"},
}

// AgentLabel turns an MCP client name ("claude-code") into a display name ("Claude").
func AgentLabel(clientName string) string {
	if n := os.Getenv("TABDRIVER_AGENT_NAME"); n != "" {
		return n
	}
	for _, p := range agentPatterns {
		if p.re.MatchString(clientName) {
			return p.label
		}
	}
	if clientName == "" {
		return "AI agent"
	}
	return clientName
}
