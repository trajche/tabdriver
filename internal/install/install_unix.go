//go:build !windows

package install

import (
	"os"
	"path/filepath"

	"github.com/trajche/tabdriver/internal/common"
)

func installOne(b browser, data []byte) (string, error) {
	return writeManifestFile(b.dir, data)
}

func uninstallOne(b browser) (string, bool) {
	file := filepath.Join(b.dir, common.HostName+".json")
	return file, os.Remove(file) == nil
}
