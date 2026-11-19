package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type rpcReply struct {
	frame map[string]any
	err   error
}

// GatewayService owns one WebSocket. It uses credentials only for the handshake,
// then discards them; it never saves or returns a token.
type GatewayService struct {
	mu              sync.Mutex
	writeMu         sync.Mutex
	conn            *websocket.Conn
	pending         map[uint64]chan rpcReply
	nextID          uint64
	epoch           uint64
	intent          uint64
	local           bool
	connecting      bool
	reconnecting    bool
	reconnectCancel context.CancelFunc
	emitFn          func(string, any)
	attachFn        func(context.Context) (attachReceipt, error)
}

func NewGatewayService() *GatewayService {
	return &GatewayService{pending: make(map[uint64]chan rpcReply)}
}

func gatewayWSURL(baseURL, token string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || u == nil || u.Host == "" || u.Opaque != "" {
		return "", errors.New("enter a valid gateway URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("gateway URL must not contain credentials, a query, or a fragment")
	}
	host := u.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	switch u.Scheme {
	case "http":
		if !loopback {
			return "", errors.New("non-loopback gateways require HTTPS")
		}
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", errors.New("gateway URL must use HTTP or HTTPS")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/ws"
	u.RawPath = ""
	if token != "" {
		q := url.Values{}
		q.Set("token", token)
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

func validateDirectWSURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return "", errors.New("enter a valid gateway WebSocket URL")
	}
	if !strings.HasSuffix(u.Path, "/api/ws") {
		return "", errors.New("gateway WebSocket URL must end in /api/ws")
	}
	host := u.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	switch u.Scheme {
	case "ws":
		if !loopback {
			return "", errors.New("non-loopback gateways require WSS")
		}
	case "wss":
	default:
		return "", errors.New("gateway WebSocket URL must use WS or WSS")
	}
	return u.String(), nil
}

func (g *GatewayService) emit(name string, data any) {
	if g.emitFn != nil {
		g.emitFn(name, data)
		return
	}
	application.Get().Event.Emit(name, data)
}

// beginConnection invalidates any in-flight reconnect before a manual choice.
func (g *GatewayService) beginConnection(local bool) uint64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reconnectCancel != nil {
		g.reconnectCancel()
		g.reconnectCancel = nil
	}
	g.intent++
	g.local = local
	g.connecting = true
	g.reconnecting = false
	return g.intent
}

func (g *GatewayService) connectionFailed(intent uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.intent == intent {
		g.connecting = false
		if g.conn == nil {
			g.local = false
		}
	}
}

// Connect replaces the active connection. Tokens are never saved or returned.
func (g *GatewayService) Connect(baseURL, token string) error {
	wsURL, err := gatewayWSURL(baseURL, token)
	if err != nil {
		return err
	}
	intent := g.beginConnection(false)
	err = g.dial(wsURL, nil, intent)
	if err != nil {
		g.connectionFailed(intent)
	}
	return err
}

// ConnectTicket uses the one-use URL and subprotocols returned by
// `hermes gateway attach --start --json`. It does not persist the ticket.
func (g *GatewayService) ConnectTicket(wsURL string, protocols []string) error {
	validated, err := validateDirectWSURL(wsURL)
	if err != nil {
		return err
	}
	if len(protocols) == 0 {
		return errors.New("attach ticket subprotocols are required")
	}
	for _, protocol := range protocols {
		if protocol == "" || strings.ContainsAny(protocol, " \t\r\n,") {
			return errors.New("invalid WebSocket subprotocol")
		}
	}
	intent := g.beginConnection(false)
	err = g.dial(validated, protocols, intent)
	if err != nil {
		g.connectionFailed(intent)
	}
	return err
}

func (g *GatewayService) dial(wsURL string, protocols []string, intent uint64) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Subprotocols: protocols}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	conn, response, err := dialer.DialContext(ctx, wsURL, http.Header{})
	if err != nil {
		if response != nil {
			return fmt.Errorf("gateway rejected WebSocket connection: HTTP %d", response.StatusCode)
		}
		return errors.New("could not connect to gateway WebSocket")
	}
	if len(protocols) != 0 && conn.Subprotocol() != "hermes-gateway-v1" {
		_ = conn.Close()
		return errors.New("gateway did not select the Hermes WebSocket protocol")
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, firstBytes, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		return errors.New("gateway did not send a ready event")
	}
	frames := decodeFrames(firstBytes)
	if len(frames) == 0 || !isGatewayReady(frames[0]) {
		_ = conn.Close()
		return errors.New("endpoint did not identify itself as a Hermes gateway")
	}
	_ = conn.SetReadDeadline(time.Time{})

	g.mu.Lock()
	if g.intent != intent {
		g.mu.Unlock()
		_ = conn.Close()
		return errors.New("gateway connection attempt was canceled")
	}
	old := g.conn
	g.epoch++
	epoch := g.epoch
	g.conn = conn
	g.connecting = false
	g.reconnecting = false
	if g.reconnectCancel != nil {
		g.reconnectCancel()
	}
	g.reconnectCancel = nil
	previous := g.pending
	g.pending = make(map[uint64]chan rpcReply)
	g.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	for _, ch := range previous {
		ch <- rpcReply{err: errors.New("gateway connection replaced")}
	}
	for _, frame := range frames {
		g.emit("gateway:event", frame)
	}
	g.emit("gateway:status", "connected")
	go g.readLoop(conn, epoch)
	go g.heartbeatLoop(conn, epoch)
	return nil
}

func isGatewayReady(frame map[string]any) bool {
	if frame["method"] != "event" {
		return false
	}
	params, ok := frame["params"].(map[string]any)
	return ok && params["type"] == "gateway.ready"
}

func (g *GatewayService) readLoop(conn *websocket.Conn, epoch uint64) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			g.finishConnection(conn, epoch)
			return
		}
		for _, frame := range decodeFrames(raw) {
			if key, ok := responseID(frame); ok {
				g.mu.Lock()
				ch := g.pending[key]
				delete(g.pending, key)
				g.mu.Unlock()
				if ch != nil {
					ch <- rpcReply{frame: frame}
					continue
				}
			}
			g.emit("gateway:event", frame)
		}
	}
}

func decodeFrames(raw []byte) []map[string]any {
	var frames []map[string]any
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var frame map[string]any
		if json.Unmarshal([]byte(line), &frame) == nil {
			frames = append(frames, frame)
		}
	}
	return frames
}

func responseID(frame map[string]any) (uint64, bool) {
	switch id := frame["id"].(type) {
	case float64:
		if id > 0 && id <= float64(^uint64(0)) {
			return uint64(id), true
		}
	case string:
		value, err := strconv.ParseUint(id, 10, 64)
		return value, err == nil
	}
	return 0, false
}

func (g *GatewayService) heartbeatLoop(conn *websocket.Conn, epoch uint64) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		g.mu.Lock()
		active := g.conn == conn && g.epoch == epoch
		g.mu.Unlock()
		if !active {
			return
		}
		if _, err := g.Call("gateway.ping", nil); err != nil {
			g.finishConnection(conn, epoch)
			return
		}
	}
}

func (g *GatewayService) finishConnection(conn *websocket.Conn, epoch uint64) {
	g.mu.Lock()
	if g.conn != conn || g.epoch != epoch {
		g.mu.Unlock()
		return
	}
	g.conn = nil
	pending := g.pending
	g.pending = make(map[uint64]chan rpcReply)
	shouldReconnect := g.local && !g.reconnecting && !g.connecting
	var reconnectCtx context.Context
	var intent uint64
	if shouldReconnect {
		g.reconnecting = true
		reconnectCtx, g.reconnectCancel = context.WithCancel(context.Background())
		intent = g.intent
	}
	g.mu.Unlock()
	_ = conn.Close()
	for _, ch := range pending {
		ch <- rpcReply{err: errors.New("gateway disconnected")}
	}
	if shouldReconnect {
		g.emit("gateway:status", "reconnecting")
		go g.reconnectLocal(reconnectCtx, intent)
	} else {
		g.emit("gateway:status", "disconnected")
	}
}

func (g *GatewayService) Disconnect() {
	g.mu.Lock()
	g.intent++
	g.local = false
	g.connecting = false
	if g.reconnectCancel != nil {
		g.reconnectCancel()
		g.reconnectCancel = nil
	}
	g.reconnecting = false
	conn := g.conn
	epoch := g.epoch
	g.mu.Unlock()
	if conn != nil {
		g.finishConnection(conn, epoch)
	} else {
		g.emit("gateway:status", "disconnected")
	}
}

// Call returns the full JSON-RPC response envelope. Errors reject the Wails call.
func (g *GatewayService) Call(method string, params map[string]any) (map[string]any, error) {
	if strings.TrimSpace(method) == "" {
		return nil, errors.New("method is required")
	}
	if params == nil {
		params = map[string]any{}
	}
	g.mu.Lock()
	conn := g.conn
	if conn == nil {
		g.mu.Unlock()
		return nil, errors.New("not connected to a gateway")
	}
	g.nextID++
	id := g.nextID
	ch := make(chan rpcReply, 1)
	g.pending[id] = ch
	g.mu.Unlock()

	request := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	g.writeMu.Lock()
	err := conn.WriteJSON(request)
	g.writeMu.Unlock()
	if err != nil {
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, errors.New("gateway write failed")
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case reply := <-ch:
		if reply.err != nil {
			return nil, reply.err
		}
		if rpcError, ok := reply.frame["error"].(map[string]any); ok {
			return nil, fmt.Errorf("gateway RPC error: %v", rpcError["message"])
		}
		return reply.frame, nil
	case <-timer.C:
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, errors.New("gateway request timed out")
	}
}
