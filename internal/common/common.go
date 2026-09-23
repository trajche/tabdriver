// Package common holds constants and helpers shared by the native host, the
// MCP server and the installer.
package common

import (
	"os"
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

// BaseDir is ~/.tabdriver (overridable with TABDRIVER_HOME, used by tests).
func BaseDir() string {
	if d := os.Getenv("TABDRIVER_HOME"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return filepath.Join(home, ".tabdriver")
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
