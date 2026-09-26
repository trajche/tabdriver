package mcpserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/trajche/tabdriver/internal/hub"
)

// Storyboard recording: while it runs, every action is preceded by a frame of the tab with a
// marker showing where it happens and what it is (click, type, scroll, ...), and every page
// load gets a frame too. record_stop turns the frames into storyboard.html/.md and a GIF.
// Each agent runs its own MCP server, so there is one recorder per agent.

type step struct {
	N       int
	Kind    string
	Caption string
	URL     string
	Title   string
	File    string
	At      time.Duration
}

type recorder struct {
	mu      sync.Mutex
	dir     string // empty when not recording
	started time.Time
	steps   []step
}

var rec = &recorder{}

// markKinds maps action tools to the marker drawn before them.
var markKinds = map[string]string{
	"click": "click", "type": "type", "select_option": "select", "press_key": "key",
	"scroll": "scroll", "hover": "hover", "upload_file": "drop",
}

func (r *recorder) recording() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dir != ""
}

// before records a frame for an action tool about to run.
func (r *recorder) before(h *hub.Hub, tool string, in any) {
	kind, ok := markKinds[tool]
	if !ok || !r.recording() {
		return
	}
	args := toMap(in)
	mark := map[string]any{"kind": kind}
	for _, k := range []string{"ref", "selector", "text", "value", "key", "direction", "pixels"} {
		if v, ok := args[k]; ok {
			mark[k] = v
		}
	}
	if paths, ok := args["paths"].([]any); ok {
		names := []string{}
		for _, p := range paths {
			names = append(names, filepath.Base(fmt.Sprint(p)))
		}
		mark["files"] = strings.Join(names, ", ")
	}
	r.frame(h, args["tabId"], mark)
}

// after records the page an action opened or navigated to.
func (r *recorder) after(h *hub.Hub, tool string, in any, result json.RawMessage) {
	if (tool != "navigate" && tool != "open_tab") || !r.recording() {
		return
	}
	tabID := toMap(in)["tabId"]
	var tab struct {
		TabID *int `json:"tabId"`
	}
	if json.Unmarshal(result, &tab) == nil && tab.TabID != nil {
		tabID = *tab.TabID
	}
	r.frame(h, tabID, map[string]any{"kind": "page"})
}

func (r *recorder) frame(h *hub.Hub, tabID any, mark map[string]any) {
	params := map[string]any{"mark": mark}
	if tabID != nil {
		params["tabId"] = tabID
	}
	data, err := h.Call("storyboard_frame", params, 20*time.Second)
	if err != nil {
		log.Printf("storyboard frame: %v", err) // never block the action itself
		return
	}
	var f struct {
		Data    string `json:"data"`
		Caption string `json:"caption"`
		URL     string `json:"url"`
		Title   string `json:"title"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dir == "" {
		return
	}
	n := len(r.steps) + 1
	kind := fmt.Sprint(mark["kind"])
	file := fmt.Sprintf("steps/%02d-%s.jpg", n, kind)
	if err := os.WriteFile(filepath.Join(r.dir, file), raw, 0o644); err != nil {
		log.Printf("storyboard frame: %v", err)
		return
	}
	r.steps = append(r.steps, step{N: n, Kind: kind, Caption: f.Caption, URL: f.URL, Title: f.Title, File: file, At: time.Since(r.started)})
}

func toMap(in any) map[string]any {
	m := map[string]any{}
	if b, err := json.Marshal(in); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func addRecording(s *mcp.Server, h *hub.Hub) {
	type startIn struct {
		tabArg
		Dir *string `json:"dir,omitempty" jsonschema:"Folder for the recording (default ./recordings/<date-time>)."`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "record_start",
		Description: "Start a storyboard recording: before each action (click, type, select, hover, scroll, key, file drop) " +
			"and after each page load, a screenshot is saved with a pointer and icon showing what happens where. " +
			"record_stop writes storyboard.html, storyboard.md and recording.gif. Use it to document a flow or an issue."},
		func(_ context.Context, _ *mcp.CallToolRequest, in startIn) (*mcp.CallToolResult, any, error) {
			dir := "./recordings/" + time.Now().Format("2006-01-02-150405")
			if in.Dir != nil && *in.Dir != "" {
				dir = *in.Dir
			}
			dir, err := expandPath(dir)
			if err != nil {
				return nil, nil, err
			}
			if err := os.MkdirAll(filepath.Join(dir, "steps"), 0o755); err != nil {
				return nil, nil, err
			}
			rec.mu.Lock()
			if rec.dir != "" {
				rec.mu.Unlock()
				return nil, nil, errors.New("already recording to " + rec.dir + "; call record_stop first")
			}
			rec.dir, rec.started, rec.steps = dir, time.Now(), nil
			rec.mu.Unlock()
			var tabID any
			if in.TabID != nil {
				tabID = *in.TabID
			}
			rec.frame(h, tabID, map[string]any{"kind": "page"})
			return text("Recording to " + dir + ". Each action now gets a storyboard frame; call record_stop when done."), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "record_stop",
		Description: "Stop the storyboard recording and write storyboard.html, storyboard.md and recording.gif."},
		func(_ context.Context, _ *mcp.CallToolRequest, in tabArg) (*mcp.CallToolResult, any, error) {
			if !rec.recording() {
				return nil, nil, errors.New("not recording; call record_start first")
			}
			var tabID any
			if in.TabID != nil {
				tabID = *in.TabID
			}
			rec.frame(h, tabID, map[string]any{"kind": "page"}) // how it ended
			rec.mu.Lock()
			dir, steps := rec.dir, rec.steps
			rec.dir, rec.steps = "", nil
			rec.mu.Unlock()
			if len(steps) == 0 {
				return text("Recording stopped; no frames were captured."), nil, nil
			}
			if err := writeStoryboard(dir, steps); err != nil {
				return nil, nil, err
			}
			if err := writeGIF(dir, steps); err != nil {
				return nil, nil, fmt.Errorf("storyboard written, GIF failed: %w", err)
			}
			return text(fmt.Sprintf("Recorded %d steps in %s:\n  storyboard.html\n  storyboard.md\n  recording.gif\n  steps/",
				len(steps), dir)), nil, nil
		})
}

func writeStoryboard(dir string, steps []step) error {
	var md, cards strings.Builder
	md.WriteString("# Storyboard\n\n")
	for _, s := range steps {
		fmt.Fprintf(&md, "%d. **%s** (+%.1fs)  \n   %s  \n   ![](%s)\n\n", s.N, s.Caption, s.At.Seconds(), s.URL, s.File)
		fmt.Fprintf(&cards, `<figure><a href="%[1]s"><img src="%[1]s" loading="lazy" alt=""></a>`+
			`<figcaption><span class="n">%[2]d</span><span class="k %[3]s">%[3]s</span> %[4]s<small>+%.1[6]fs · %[5]s</small></figcaption></figure>`+"\n",
			html.EscapeString(s.File), s.N, html.EscapeString(s.Kind), html.EscapeString(s.Caption), html.EscapeString(s.URL), s.At.Seconds())
	}
	page := `<!doctype html><html><head><meta charset="utf-8"><title>Storyboard</title>
<style>
:root { --bg: #f5f4f1; --card: #fff; --fg: #1f1f1f; --muted: #777; --accent: #d97757; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1a1e; --card: #26252a; --fg: #eee; --muted: #999; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 20px; margin: 0 0 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
figure { margin: 0; background: var(--card); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
img { display: block; width: 100%; }
figcaption { padding: 10px 12px; }
.n { display: inline-grid; place-items: center; min-width: 22px; height: 22px; border-radius: 11px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; margin-right: 6px; }
.k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-right: 4px; }
small { display: block; color: var(--muted); margin-top: 4px; overflow-wrap: anywhere; }
</style></head><body><main><h1>Storyboard · ` + fmt.Sprint(len(steps)) + ` steps</h1>
<p><img src="recording.gif" alt="" style="max-width:720px;border-radius:12px"></p>
<div class="grid">
` + cards.String() + `</div></main></body></html>
`
	if err := os.WriteFile(filepath.Join(dir, "storyboard.html"), []byte(page), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "storyboard.md"), []byte(md.String()), 0o644)
}

// writeGIF makes a slideshow of the frames, 1.5 s each, at most 960 px wide.
func writeGIF(dir string, steps []step) error {
	anim := &gif.GIF{LoopCount: 0}
	for i, s := range steps {
		raw, err := os.ReadFile(filepath.Join(dir, s.File))
		if err != nil {
			return err
		}
		img, err := jpeg.Decode(bytes.NewReader(raw))
		if err != nil {
			return err
		}
		img = shrink(img, 960)
		pal := image.NewPaletted(img.Bounds(), palette.Plan9)
		draw.FloydSteinberg.Draw(pal, img.Bounds(), img, image.Point{})
		delay := 150
		if i == len(steps)-1 {
			delay = 300
		}
		anim.Image = append(anim.Image, pal)
		anim.Delay = append(anim.Delay, delay)
	}
	f, err := os.Create(filepath.Join(dir, "recording.gif"))
	if err != nil {
		return err
	}
	defer f.Close()
	return gif.EncodeAll(f, anim)
}

// shrink scales img down to maxW wide by averaging source pixels (box filter).
func shrink(img image.Image, maxW int) image.Image {
	b := img.Bounds()
	if b.Dx() <= maxW {
		return img
	}
	w, h := maxW, b.Dy()*maxW/b.Dx()
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0, y1 := b.Min.Y+y*b.Dy()/h, b.Min.Y+(y+1)*b.Dy()/h
		for x := 0; x < w; x++ {
			x0, x1 := b.Min.X+x*b.Dx()/w, b.Min.X+(x+1)*b.Dx()/w
			var r, g, bl, n uint32
			for sy := y0; sy < max(y1, y0+1); sy++ {
				for sx := x0; sx < max(x1, x0+1); sx++ {
					cr, cg, cb, _ := img.At(sx, sy).RGBA()
					r, g, bl, n = r+cr, g+cg, bl+cb, n+1
				}
			}
			i := out.PixOffset(x, y)
			out.Pix[i], out.Pix[i+1], out.Pix[i+2], out.Pix[i+3] = uint8(r/n>>8), uint8(g/n>>8), uint8(bl/n>>8), 255
		}
	}
	return out
}
