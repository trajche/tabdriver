//go:build windows

package install

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"

	"github.com/trajche/tabdriver/internal/common"
)

// On Windows the manifest can live anywhere; the browser finds it through a
// per-user registry key whose default value is the manifest path.
func manifestDir(b browser) string {
	name := "chromium"
	if b.firefox {
		name = "firefox"
	}
	return filepath.Join(common.BaseDir(), "manifests", name)
}

func installOne(b browser, data []byte) (string, error) {
	file, err := writeManifestFile(manifestDir(b), data)
	if err != nil {
		return "", err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, b.regKey+`\`+common.HostName, registry.SET_VALUE)
	if err != nil {
		return "", err
	}
	defer key.Close()
	if err := key.SetStringValue("", file); err != nil {
		return "", err
	}
	return `HKCU\` + b.regKey + `\` + common.HostName, nil
}

func uninstallOne(b browser) (string, bool) {
	path := b.regKey + `\` + common.HostName
	err := registry.DeleteKey(registry.CURRENT_USER, path)
	os.Remove(filepath.Join(manifestDir(b), common.HostName+".json"))
	return `HKCU\` + path, err == nil
}
