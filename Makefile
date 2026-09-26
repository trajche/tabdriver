VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/trajche/tabdriver/internal/common.Version=$(VERSION)
PREFIX  ?= $(HOME)/.local
TARGETS := darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: build install uninstall dist firefox firefox-sign test test-firefox vet clean

build: ## Build for this machine into bin/
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/tabdriver ./cmd/tabdriver

install: build ## Copy to $(PREFIX)/bin and register the native host with browsers
	install -d $(PREFIX)/bin
	install -m 755 bin/tabdriver $(PREFIX)/bin/tabdriver
	$(PREFIX)/bin/tabdriver install

uninstall:
	-$(PREFIX)/bin/tabdriver uninstall
	rm -f $(PREFIX)/bin/tabdriver

dist: ## Cross-compile release binaries into dist/
	@mkdir -p dist
	@for t in $(TARGETS); do \
		os=$${t%/*}; arch=$${t#*/}; ext=; [ $$os = windows ] && ext=.exe; \
		echo "dist/tabdriver-$$os-$$arch$$ext"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o dist/tabdriver-$$os-$$arch$$ext ./cmd/tabdriver || exit 1; \
	done

EXT_FILES := background.js page-agent.js popup.html popup.js

firefox: ## Firefox build of the extension: build/firefox/ (load via about:debugging) and dist/tabdriver-firefox.xpi
	@rm -rf build/firefox && mkdir -p build/firefox dist
	cd extension && cp -R $(EXT_FILES) icons ../build/firefox/ && cp manifest.firefox.json ../build/firefox/manifest.json
	rm -f dist/tabdriver-firefox.xpi && cd build/firefox && zip -qr ../../dist/tabdriver-firefox.xpi .
	@echo "build/firefox/  dist/tabdriver-firefox.xpi (unsigned)"

firefox-sign: firefox ## Sign an unlisted .xpi with AMO (needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET)
	cd build/firefox && npx --yes web-ext sign --channel unlisted --artifacts-dir ../../dist

vet:
	go vet ./...
	@test -z "$$(gofmt -l .)" || (gofmt -l .; exit 1)
	@v() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/$$1; }; \
		test "$$(v manifest.json)" = "$$(v manifest.firefox.json)" || (echo "extension manifest versions differ"; exit 1)

test: vet build ## End-to-end test in a throwaway Chromium (needs Node)
	[ -d test/node_modules ] || (cd test && npm install && npx playwright install chromium)
	node test/e2e.mjs bin/tabdriver

test-firefox: vet build firefox ## Same end-to-end test in a throwaway Firefox profile (needs Node and Firefox 128+)
	[ -d test/node_modules ] || (cd test && npm install)
	node test/e2e.mjs bin/tabdriver --firefox

clean:
	rm -rf bin build dist
