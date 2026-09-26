VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/trajche/tabdriver/internal/common.Version=$(VERSION)
PREFIX  ?= $(HOME)/.local

.PHONY: build install uninstall snapshot chrome firefox firefox-sign test test-firefox vet clean

build: ## Build for this machine into bin/
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/tabdriver ./cmd/tabdriver

install: build ## Copy to $(PREFIX)/bin and register the native host with browsers
	install -d $(PREFIX)/bin
	install -m 755 bin/tabdriver $(PREFIX)/bin/tabdriver
	$(PREFIX)/bin/tabdriver install

uninstall:
	-$(PREFIX)/bin/tabdriver uninstall
	rm -f $(PREFIX)/bin/tabdriver

snapshot: ## Local release build with GoReleaser (binaries, archives, cask, scoop) into dist/, publishes nothing
	go run github.com/goreleaser/goreleaser/v2@latest release --snapshot --clean

# Extension packages in build/. EXT_VERSION (set from the git tag in CI) overrides the manifest version.
EXT_FILES := background.js page-agent.js popup.html popup.js app-setup.js setup.html setup.js icons
EXT_VERSION ?=
define package_ext # $(1) browser, $(2) source manifest
	@rm -rf build/$(1) build/tabdriver-$(1).zip && mkdir -p build/$(1)
	cd extension && cp -R $(EXT_FILES) ../build/$(1)/ && cp $(2) ../build/$(1)/manifest.json
	$(if $(EXT_VERSION),sed -i.bak 's/"version": "[^"]*"/"version": "$(EXT_VERSION)"/' build/$(1)/manifest.json && rm build/$(1)/manifest.json.bak)
	cd build/$(1) && zip -qr ../tabdriver-$(1).zip .
	@echo "build/$(1)/  build/tabdriver-$(1).zip"
endef

chrome: ## Chrome extension: build/chrome/ and build/tabdriver-chrome.zip
	$(call package_ext,chrome,manifest.json)

firefox: ## Firefox add-on: build/firefox/ (load via about:debugging) and build/tabdriver-firefox.zip
	$(call package_ext,firefox,manifest.firefox.json)

firefox-sign: firefox ## Sign build/firefox with AMO as unlisted (private) -> build/tabdriver-firefox.xpi. Needs WEB_EXT_API_KEY, WEB_EXT_API_SECRET
	@rm -f build/*.xpi
	npx --yes web-ext@8 sign --channel unlisted --source-dir build/firefox --artifacts-dir build
	mv "$$(ls -t build/*.xpi | head -1)" build/tabdriver-firefox.xpi
	@echo "build/tabdriver-firefox.xpi"

vet:
	go vet ./...
	@test -z "$$(gofmt -l .)" || (gofmt -l .; exit 1)
	@v() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/$$1; }; \
		test "$$(v manifest.json)" = "$$(v manifest.firefox.json)" || (echo "extension manifest versions differ"; exit 1)

test: vet build ## End-to-end test in a throwaway Chromium (needs Node)
	[ -d test/node_modules ] || (cd test && npm install && npx playwright install chromium)
	node test/e2e.mjs bin/tabdriver
	node test/missing-app.mjs bin/tabdriver

test-firefox: vet build firefox ## Same end-to-end test in a throwaway Firefox profile (needs Node and Firefox 128+)
	[ -d test/node_modules ] || (cd test && npm install)
	node test/e2e.mjs bin/tabdriver --firefox

clean:
	rm -rf bin build dist
