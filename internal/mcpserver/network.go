package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/trajche/tabdriver/internal/hub"
)

// Network tools: the request log of controlled tabs, single requests in full, and HAR recording.
func addNetwork(s *mcp.Server, h *hub.Hub) {
	d30 := 30 * time.Second

	type networkIn struct {
		tabArg
		Filter     *string `json:"filter,omitempty" jsonschema:"Only URLs containing this text, e.g. /api/."`
		FailedOnly *bool   `json:"failedOnly,omitempty" jsonschema:"Only failed requests and HTTP 4xx/5xx."`
		Types      *string `json:"types,omitempty" jsonschema:"Comma-separated: doc, xhr (fetch/XHR), js, css, img, font, media, ws, frame, ping, other."`
		Limit      *int    `json:"limit,omitempty" jsonschema:"Most recent N (default 60)."`
	}
	forward(s, h, "network",
		"List a controlled tab's recent requests (up to 500 kept while it's controlled): id, time, method, status, type, size, duration, URL. "+
			"Use types=xhr to see the API calls a page makes, then network_request for one in full.",
		fixed[networkIn](d30))

	type requestIn struct {
		tabArg
		ID             string `json:"id" jsonschema:"Request id from network, e.g. n12."`
		IncludeSecrets *bool  `json:"includeSecrets,omitempty" jsonschema:"Show cookies, auth headers and password/token fields (redacted by default)."`
		MaxBodyChars   *int   `json:"maxBodyChars,omitempty" jsonschema:"Cap on each body's length (default 20000)."`
	}
	forward(s, h, "network_request",
		"Show one request in full: method, URL, status, request and response headers, request body, and the response body "+
			"if it was captured by a HAR recording (har_start). Use it to see exactly how a page calls its API.",
		fixed[requestIn](d30))

	type harStartIn struct {
		tabArg
		IncludeSecrets *bool `json:"includeSecrets,omitempty" jsonschema:"Keep cookies, auth headers and password/token fields in the HAR (redacted by default). Only for your own use: the file then holds live session credentials."`
	}
	forward(s, h, "har_start",
		"Start recording a controlled tab's network traffic as a HAR, with request and response bodies (text types, up to 2 MB each). "+
			"Reload or act in the page, then call har_stop. In Chrome the browser shows a 'being debugged' bar while recording.",
		fixed[harStartIn](d30))

	type harStopIn struct {
		tabArg
		Path *string `json:"path,omitempty" jsonschema:"Where to save the .har (default ./recordings/<date-time>.har)."`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "har_stop",
		Description: "Stop the HAR recording, save it (open it in browser DevTools or any HAR viewer), and list the API endpoints the page called."},
		func(_ context.Context, _ *mcp.CallToolRequest, in harStopIn) (*mcp.CallToolResult, any, error) {
			path := "./recordings/" + time.Now().Format("2006-01-02-150405") + ".har"
			if in.Path != nil && *in.Path != "" {
				path = *in.Path
			}
			path, err := expandPath(path)
			if err != nil {
				return nil, nil, err
			}
			data, err := h.Call("har_stop", in.tabArg, 90*time.Second)
			if err != nil {
				return nil, nil, err
			}
			var out struct {
				HAR       json.RawMessage `json:"har"`
				Entries   int             `json:"entries"`
				Endpoints []string        `json:"endpoints"`
				Truncated int             `json:"truncated"`
				Secrets   string          `json:"secrets"`
			}
			if err := json.Unmarshal(data, &out); err != nil {
				return nil, nil, err
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return nil, nil, err
			}
			if err := os.WriteFile(path, out.HAR, 0o600); err != nil { // may hold session data: owner-only
				return nil, nil, err
			}
			var b strings.Builder
			fmt.Fprintf(&b, "Saved %d requests to %s (secrets %s).\n", out.Entries, path, out.Secrets)
			if out.Truncated > 0 {
				fmt.Fprintf(&b, "%d response bodies were too large to keep (over 2 MB, or the 40 MB recording limit).\n", out.Truncated)
			}
			if len(out.Endpoints) > 0 {
				b.WriteString("\nAPI calls (XHR/fetch), by method and path:\n")
				for _, e := range out.Endpoints {
					b.WriteString("  " + e + "\n")
				}
			}
			return text(b.String()), nil, nil
		})
}
