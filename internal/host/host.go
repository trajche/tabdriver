// Package host implements the native messaging host.
//
// The browser launches it (chrome.runtime.connectNative) and talks to the
// extension over stdio using native messaging framing: a uint32 length in
// native byte order (little endian on all supported platforms) followed by
// JSON. The host exposes a Unix socket in ~/.tabdriver/hosts (directory mode
// 0700) so any number of MCP servers can send commands to this browser.
package host

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/trajche/tabdriver/internal/common"
)

const (
	// Chrome rejects messages from a native host larger than 1 MB; split bigger ones.
	maxNativeMsg = 900 * 1024
	chunkBytes   = 600 * 1024
	// Messages from the extension may be up to 64 MiB.
	maxInbound = 64 << 20
)

// extMsg is the wire format between host and extension.
type extMsg struct {
	Type    string          `json:"type,omitempty"`
	ID      int64           `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Agent   string          `json:"agent,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Browser json.RawMessage `json:"browser,omitempty"`
	Agents  []string        `json:"agents,omitempty"`
}

// sockMsg is the wire format between host and MCP servers (newline-delimited JSON).
type sockMsg struct {
	Type      string          `json:"type,omitempty"`
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	Agent     string          `json:"agent,omitempty"`
	Browser   json.RawMessage `json:"browser,omitempty"`
	PID       int             `json:"pid,omitempty"`
	StartedAt int64           `json:"startedAt,omitempty"`
}

type client struct {
	enc   *json.Encoder
	mu    sync.Mutex
	agent string
}

func (c *client) send(m sockMsg) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.enc.Encode(m)
}

type pendingReq struct {
	client *client
	id     int64
}

type Host struct {
	mu        sync.Mutex
	outMu     sync.Mutex
	out       io.Writer
	clients   map[*client]struct{}
	pending   map[int64]pendingReq
	nextID    int64
	chunkSeq  int64
	browser   json.RawMessage
	startedAt int64
	sockPath  string
	metaPath  string
}

// Run serves until the browser closes stdin.
func Run() error {
	base, hosts := common.BaseDir(), common.HostsDir()
	for _, d := range []string{base, hosts} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
		_ = os.Chmod(d, 0o700)
	}
	setupLog(filepath.Join(base, "host.log"))

	pid := os.Getpid()
	h := &Host{
		out:       os.Stdout,
		clients:   map[*client]struct{}{},
		pending:   map[int64]pendingReq{},
		startedAt: time.Now().UnixMilli(),
		sockPath:  filepath.Join(hosts, strconv.Itoa(pid)+".sock"),
		metaPath:  filepath.Join(hosts, strconv.Itoa(pid)+".json"),
	}

	_ = os.Remove(h.sockPath)
	ln, err := net.Listen("unix", h.sockPath)
	if err != nil {
		log.Printf("listen: %v", err)
		return err
	}
	_ = os.Chmod(h.sockPath, 0o600)
	h.writeMeta()
	log.Printf("listening on %s", h.sockPath)

	cleanup := func() {
		ln.Close()
		os.Remove(h.sockPath)
		os.Remove(h.metaPath)
		log.Printf("shutting down")
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, os.Interrupt)
	go func() { <-sigs; cleanup(); os.Exit(0) }()

	go h.acceptLoop(ln)
	h.readExtension(os.Stdin) // returns when the browser disconnects
	cleanup()
	return nil
}

func setupLog(path string) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > 1<<20 {
		_ = os.Truncate(path, 0)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.SetOutput(io.Discard)
		return
	}
	log.SetOutput(f)
	log.SetPrefix(fmt.Sprintf("[%d] ", os.Getpid()))
	log.SetFlags(log.LstdFlags | log.LUTC)
}

func (h *Host) writeMeta() {
	h.mu.Lock()
	meta, _ := json.Marshal(map[string]any{
		"pid": os.Getpid(), "browser": h.browser, "startedAt": h.startedAt, "socket": h.sockPath,
	})
	h.mu.Unlock()
	_ = os.WriteFile(h.metaPath, meta, 0o600)
}

// ---------- extension side ----------

func (h *Host) readExtension(r io.Reader) {
	br := bufio.NewReaderSize(r, 64*1024)
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return
		}
		n := binary.LittleEndian.Uint32(hdr[:])
		if n > maxInbound {
			log.Printf("message too large: %d", n)
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(br, body); err != nil {
			return
		}
		var m extMsg
		if err := json.Unmarshal(body, &m); err != nil {
			continue
		}
		h.onExtension(m)
	}
}

func (h *Host) onExtension(m extMsg) {
	if m.Type == "hello" {
		h.mu.Lock()
		h.browser = m.Browser
		clients := h.clientList()
		h.mu.Unlock()
		h.writeMeta()
		log.Printf("extension hello %s", m.Browser)
		h.notifyAgents()
		for _, c := range clients {
			c.send(sockMsg{Type: "browser", Browser: m.Browser})
		}
		return
	}
	if m.ID == 0 {
		return
	}
	h.mu.Lock()
	p, ok := h.pending[m.ID]
	delete(h.pending, m.ID)
	h.mu.Unlock()
	if ok {
		p.client.send(sockMsg{ID: p.id, Result: m.Result, Error: m.Error})
	}
}

func (h *Host) writeNative(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if len(data) <= maxNativeMsg {
		h.writeFrame(data)
		return
	}
	h.chunkSeq++
	total := (len(data) + chunkBytes - 1) / chunkBytes
	for seq := 0; seq < total; seq++ {
		end := min((seq+1)*chunkBytes, len(data))
		chunk, _ := json.Marshal(map[string]any{
			"type": "chunk", "cid": h.chunkSeq, "seq": seq, "total": total,
			"data": base64.StdEncoding.EncodeToString(data[seq*chunkBytes : end]),
		})
		h.writeFrame(chunk)
	}
}

func (h *Host) writeFrame(payload []byte) {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(payload)))
	_, _ = h.out.Write(append(hdr[:], payload...))
}

func (h *Host) notifyAgents() {
	h.mu.Lock()
	names := []string{}
	for c := range h.clients {
		if c.agent != "" {
			names = append(names, c.agent)
		}
	}
	h.mu.Unlock()
	h.writeNative(extMsg{Type: "agents", Agents: names})
}

// clientList must be called with h.mu held.
func (h *Host) clientList() []*client {
	out := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		out = append(out, c)
	}
	return out
}

// ---------- agent side (MCP servers) ----------

func (h *Host) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go h.serveClient(conn)
	}
}

func (h *Host) serveClient(conn net.Conn) {
	c := &client{enc: json.NewEncoder(conn)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	defer func() {
		conn.Close()
		h.mu.Lock()
		delete(h.clients, c)
		for id, p := range h.pending {
			if p.client == c {
				delete(h.pending, id)
			}
		}
		h.mu.Unlock()
		h.notifyAgents()
	}()

	dec := json.NewDecoder(conn)
	for {
		var m sockMsg
		if err := dec.Decode(&m); err != nil {
			return
		}
		switch {
		case m.Type == "hello" || m.Type == "agent":
			name := m.Agent
			if name == "" {
				name = "AI agent"
			}
			if len(name) > 40 {
				name = name[:40]
			}
			h.mu.Lock()
			c.agent = name
			browser := h.browser
			h.mu.Unlock()
			if m.Type == "hello" {
				c.send(sockMsg{Type: "welcome", PID: os.Getpid(), Browser: browser, StartedAt: h.startedAt})
			}
			h.notifyAgents()
		case m.ID != 0 && m.Method != "":
			h.mu.Lock()
			h.nextID++
			hid := h.nextID
			h.pending[hid] = pendingReq{client: c, id: m.ID}
			agent := c.agent
			h.mu.Unlock()
			if agent == "" {
				agent = "AI agent"
			}
			params := m.Params
			if len(params) == 0 {
				params = json.RawMessage("{}")
			}
			h.writeNative(extMsg{ID: hid, Method: m.Method, Params: params, Agent: agent})
		}
	}
}
