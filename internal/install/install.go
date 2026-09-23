// Package install registers the native messaging host with installed browsers.
package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/trajche/tabdriver/internal/common"
)

type browser struct {
	name    string
	root    string // profile root; the browser counts as installed if it exists
	dir     string // manifest directory (macOS/Linux)
	regKey  string // HKCU key (Windows)
	firefox bool
}

func browsers() []browser {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		as := filepath.Join(home, "Library", "Application Support")
		mk := func(name, rel string, ff bool) browser {
			return browser{name: name, root: filepath.Join(as, rel), dir: filepath.Join(as, rel, "NativeMessagingHosts"), firefox: ff}
		}
		return []browser{
			mk("Arc", "Arc/User Data", false),
			mk("Chrome", "Google/Chrome", false),
			mk("Chrome Beta", "Google/Chrome Beta", false),
			mk("Chrome Canary", "Google/Chrome Canary", false),
			mk("Chromium", "Chromium", false),
			mk("Brave", "BraveSoftware/Brave-Browser", false),
			mk("Edge", "Microsoft Edge", false),
			mk("Vivaldi", "Vivaldi", false),
			mk("Firefox", "Mozilla", true),
		}
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		appdata := os.Getenv("APPDATA")
		return []browser{
			{name: "Chrome", root: filepath.Join(local, `Google\Chrome`), regKey: `Software\Google\Chrome\NativeMessagingHosts`},
			{name: "Chromium", root: filepath.Join(local, `Chromium`), regKey: `Software\Chromium\NativeMessagingHosts`},
			{name: "Edge", root: filepath.Join(local, `Microsoft\Edge`), regKey: `Software\Microsoft\Edge\NativeMessagingHosts`},
			{name: "Brave", root: filepath.Join(local, `BraveSoftware\Brave-Browser`), regKey: `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts`},
			{name: "Vivaldi", root: filepath.Join(local, `Vivaldi`), regKey: `Software\Vivaldi\NativeMessagingHosts`},
			{name: "Firefox", root: filepath.Join(appdata, `Mozilla`), regKey: `Software\Mozilla\NativeMessagingHosts`, firefox: true},
		}
	default: // linux and other unixes
		cfg := filepath.Join(home, ".config")
		mk := func(name, rel string) browser {
			return browser{name: name, root: filepath.Join(cfg, rel), dir: filepath.Join(cfg, rel, "NativeMessagingHosts")}
		}
		return []browser{
			mk("Chrome", "google-chrome"),
			mk("Chromium", "chromium"),
			mk("Brave", "BraveSoftware/Brave-Browser"),
			mk("Edge", "microsoft-edge"),
			mk("Vivaldi", "vivaldi"),
			{name: "Firefox", root: filepath.Join(home, ".mozilla"), dir: filepath.Join(home, ".mozilla", "native-messaging-hosts"), firefox: true},
		}
	}
}

func manifest(exe string, firefox bool, extraIDs []string) []byte {
	m := map[string]any{
		"name":        common.HostName,
		"description": "Tab Driver browser automation bridge",
		"path":        exe,
		"type":        "stdio",
	}
	if firefox {
		m["allowed_extensions"] = []string{common.FirefoxExtensionID}
	} else {
		origins := []string{}
		for _, id := range append([]string{common.ExtensionID}, extraIDs...) {
			origins = append(origins, "chrome-extension://"+id+"/")
		}
		m["allowed_origins"] = origins
	}
	out, _ := json.MarshalIndent(m, "", "  ")
	return append(out, '\n')
}

// hostPath is the executable the browser will launch. We keep the path as
// invoked (not symlink-resolved) so package-manager symlinks such as
// /opt/homebrew/bin/tabdriver keep working across upgrades.
func hostPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Abs(exe)
}

// Install writes host manifests for every installed browser.
func Install(extraIDs []string) error {
	exe, err := hostPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(common.BaseDir(), 0o700); err != nil {
		return err
	}
	n := 0
	for _, b := range browsers() {
		if _, err := os.Stat(b.root); err != nil {
			continue
		}
		loc, err := installOne(b, manifest(exe, b.firefox, extraIDs))
		if err != nil {
			fmt.Printf("failed    %-13s %v\n", b.name, err)
			continue
		}
		fmt.Printf("installed %-13s %s\n", b.name, loc)
		n++
	}
	if n == 0 {
		return fmt.Errorf("no supported browsers found")
	}
	fmt.Printf("\nHost: %s\nReload the Tab Driver extension (or restart the browser) to connect.\n", exe)
	return nil
}

// Uninstall removes all host manifests.
func Uninstall() error {
	n := 0
	for _, b := range browsers() {
		if loc, ok := uninstallOne(b); ok {
			fmt.Printf("removed   %-13s %s\n", b.name, loc)
			n++
		}
	}
	if n == 0 {
		fmt.Println("Nothing to remove.")
	}
	return nil
}

func writeManifestFile(dir string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	file := filepath.Join(dir, common.HostName+".json")
	return file, os.WriteFile(file, data, 0o644)
}
