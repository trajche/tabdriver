// Package hub connects an MCP server to every running native host (one per
// browser with the extension enabled) via the Unix sockets in ~/.tabdriver/hosts.
package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/trajche/tabdriver/internal/common"
)

type msg struct {
	Type      string          `json:"type,omitempty"`
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    any             `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	Agent     string          `json:"agent,omitempty"`
	Browser   json.RawMessage `json:"browser,omitempty"`
	StartedAt int64           `json:"startedAt,omitempty"`
}

type result struct {
	data json.RawMessage
	err  error
}

type conn struct {
	pid       int
	c         net.Conn
	enc       *json.Encoder
	wmu       sync.Mutex
	ready     bool
	browser   json.RawMessage
	startedAt int64
	pending   map[int64]chan result
}

func (c *conn) send(m msg) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.enc.Encode(m)
}

// BrowserInfo describes a connected browser for browser_status.
type BrowserInfo struct {
	BrowserID int    `json:"browserId"`
	Browser   string `json:"browser"`
	UserAgent string `json:"userAgent,omitempty"`
	Selected  bool   `json:"selected"`
}

type Hub struct {
	mu       sync.Mutex
	agent    string
	conns    map[int]*conn
	selected int
	nextID   int64
}

func New() *Hub {
	return &Hub{agent: "AI agent", conns: map[int]*conn{}}
}

// Start connects to existing hosts and keeps watching for new ones.
func (h *Hub) Start() {
	h.Scan()
	go func() {
		for range time.Tick(3 * time.Second) {
			h.Scan()
		}
	}()
}

func (h *Hub) Agent() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agent
}

// SetAgent updates the display name shown in the browser for this agent.
func (h *Hub) SetAgent(name string) {
	h.mu.Lock()
	h.agent = name
	conns := h.readyConns()
	h.mu.Unlock()
	for _, c := range conns {
		_ = c.send(msg{Type: "agent", Agent: name})
	}
}

// Scan connects to host sockets we are not connected to yet and waits for the attempts.
func (h *Hub) Scan() {
	entries, _ := os.ReadDir(common.HostsDir())
	var wg sync.WaitGroup
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sock") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(name, ".sock"))
		if err != nil {
			continue
		}
		h.mu.Lock()
		_, known := h.conns[pid]
		if !known {
			h.conns[pid] = &conn{pid: pid, pending: map[int64]chan result{}}
		}
		h.mu.Unlock()
		if known {
			continue
		}
		wg.Add(1)
		go func() { defer wg.Done(); h.connect(pid) }()
	}
	wg.Wait()
}

func (h *Hub) connect(pid int) {
	sockPath := filepath.Join(common.HostsDir(), strconv.Itoa(pid)+".sock")
	fail := func() {
		h.mu.Lock()
		delete(h.conns, pid)
		h.mu.Unlock()
	}
	nc, err := net.DialTimeout("unix", sockPath, time.Second)
	if err != nil {
		// Socket left behind by a crashed host: clean it up.
		if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "refused") {
			os.Remove(sockPath)
			os.Remove(strings.TrimSuffix(sockPath, ".sock") + ".json")
		}
		fail()
		return
	}
	h.mu.Lock()
	c := h.conns[pid]
	c.c, c.enc = nc, json.NewEncoder(nc)
	agent := h.agent
	h.mu.Unlock()

	welcomed := make(chan struct{})
	go h.readLoop(c, welcomed)
	if err := c.send(msg{Type: "hello", Agent: agent}); err != nil {
		nc.Close()
		return
	}
	select {
	case <-welcomed:
		log.Printf("connected to browser host %d", pid)
	case <-time.After(1500 * time.Millisecond):
		nc.Close()
	}
}

func (h *Hub) readLoop(c *conn, welcomed chan struct{}) {
	dec := json.NewDecoder(c.c)
	defer func() {
		c.c.Close()
		h.mu.Lock()
		wasReady := c.ready
		delete(h.conns, c.pid)
		pending := c.pending
		c.pending = map[int64]chan result{}
		h.mu.Unlock()
		for _, ch := range pending {
			ch <- result{err: errors.New("browser disconnected")}
		}
		if wasReady {
			log.Printf("browser host %d disconnected", c.pid)
		}
	}()
	for {
		var m msg
		if err := dec.Decode(&m); err != nil {
			return
		}
		switch {
		case m.Type == "welcome":
			h.mu.Lock()
			c.ready, c.browser, c.startedAt = true, m.Browser, m.StartedAt
			h.mu.Unlock()
			close(welcomed)
		case m.Type == "browser":
			h.mu.Lock()
			c.browser = m.Browser
			h.mu.Unlock()
		case m.ID != 0:
			h.mu.Lock()
			ch, ok := c.pending[m.ID]
			delete(c.pending, m.ID)
			h.mu.Unlock()
			if !ok {
				continue
			}
			if m.Error != "" {
				ch <- result{err: errors.New(m.Error)}
			} else {
				ch <- result{data: m.Result}
			}
		}
	}
}

// readyConns returns connected browsers, most recently started first. Caller holds h.mu.
func (h *Hub) readyConns() []*conn {
	var out []*conn
	for _, c := range h.conns {
		if c.ready {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].startedAt > out[j].startedAt })
	return out
}

// target is the selected browser, else the most recently started one. Caller holds h.mu.
func (h *Hub) target() *conn {
	if c, ok := h.conns[h.selected]; ok && c.ready {
		return c
	}
	if all := h.readyConns(); len(all) > 0 {
		return all[0]
	}
	return nil
}

func (h *Hub) List() []BrowserInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	cur := h.target()
	out := []BrowserInfo{}
	for _, c := range h.readyConns() {
		var b struct {
			Name      string `json:"name"`
			UserAgent string `json:"userAgent"`
		}
		_ = json.Unmarshal(c.browser, &b)
		if b.Name == "" {
			b.Name = "unknown"
		}
		out = append(out, BrowserInfo{BrowserID: c.pid, Browser: b.Name, UserAgent: b.UserAgent, Selected: c == cur})
	}
	return out
}

func (h *Hub) Select(id int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, ok := h.conns[id]; !ok || !c.ready {
		return fmt.Errorf("no connected browser with id %d", id)
	}
	h.selected = id
	return nil
}

var ErrNoBrowser = errors.New("no browser connected. Make sure the Tab Driver extension is loaded and enabled, " +
	"and that the native host is installed (run: tabdriver install)")

// Call sends a command to the target browser and waits for its result.
func (h *Hub) Call(method string, params any, timeout time.Duration) (json.RawMessage, error) {
	h.mu.Lock()
	c := h.target()
	h.mu.Unlock()
	if c == nil {
		h.Scan()
		h.mu.Lock()
		c = h.target()
		h.mu.Unlock()
	}
	if c == nil {
		return nil, ErrNoBrowser
	}

	ch := make(chan result, 1)
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	c.pending[id] = ch
	h.mu.Unlock()

	if err := c.send(msg{ID: id, Method: method, Params: params}); err != nil {
		h.mu.Lock()
		delete(c.pending, id)
		h.mu.Unlock()
		return nil, err
	}
	select {
	case r := <-ch:
		return r.data, r.err
	case <-time.After(timeout):
		h.mu.Lock()
		delete(c.pending, id)
		h.mu.Unlock()
		return nil, fmt.Errorf("timed out after %s waiting for %q", timeout, method)
	}
}
