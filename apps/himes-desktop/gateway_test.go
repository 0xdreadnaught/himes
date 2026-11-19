package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestGatewayWSURL(t *testing.T) {
	got, err := gatewayWSURL("http://127.0.0.1:8765", "one use token")
	if err != nil || got != "ws://127.0.0.1:8765/api/ws?token=one+use+token" {
		t.Fatalf("loopback URL = %q, %v", got, err)
	}
	if _, err := gatewayWSURL("http://192.0.2.123:8765", "secret"); err == nil {
		t.Fatal("cleartext LAN credential was accepted")
	}
	got, err = gatewayWSURL("https://gateway.example/hermes", "secret")
	if err != nil || got != "wss://gateway.example/hermes/api/ws?token=secret" {
		t.Fatalf("TLS gateway URL = %q, %v", got, err)
	}
}

func TestDirectURLDoesNotLeakCredentialsOnFailure(t *testing.T) {
	_, err := validateDirectWSURL("ws://192.0.2.123/api/ws?ticket=private-value")
	if err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("expected private validation error, got %v", err)
	}
}

func TestDecodeBatchedFrames(t *testing.T) {
	frames := decodeFrames([]byte("{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"type\":\"gateway.ready\"}}\n" +
		"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n"))
	if len(frames) != 2 || !isGatewayReady(frames[0]) {
		t.Fatalf("decoded frames = %#v", frames)
	}
	if id, ok := responseID(frames[1]); !ok || id != 2 {
		t.Fatalf("response ID = %d, %v", id, ok)
	}
}

func TestParseAttachReceipt(t *testing.T) {
	const secret = "one-use-private-ticket"
	data := []byte(`{"state":"ready","url":"ws://127.0.0.1:1234/api/ws","protocols":["hermes-gateway-v1","hermes-gateway-ticket.` + secret + `"],"ticket":"` + secret + `"}`)
	receipt, err := parseAttachReceipt(data)
	if err != nil || receipt.URL != "ws://127.0.0.1:1234/api/ws" || len(receipt.Protocols) != 2 {
		t.Fatalf("attach receipt could not be used: %v", err)
	}
	for _, invalid := range [][]byte{
		[]byte(`{"url":"ws://127.0.0.1:1234/api/ws","ticket":"` + secret + `"}`),
		[]byte(`{"url":"ws://192.0.2.123:1234/api/ws","protocols":["hermes-gateway-v1"]}`),
		[]byte(`{"url":"ws://127.0.0.1:1234/api/ws","protocols":["other"]}`),
		[]byte(`not json ` + secret),
	} {
		_, err := parseAttachReceipt(invalid)
		if err == nil || strings.Contains(err.Error(), secret) {
			t.Fatalf("invalid attach receipt leaked secret or passed: %v", err)
		}
	}
}

func TestLimitedAttachOutput(t *testing.T) {
	w := limitedOutput{max: 4}
	if _, err := w.Write([]byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("e")); err == nil {
		t.Fatal("attach output exceeded its bound")
	}
}

func TestLocalReconnectUsesFreshTicket(t *testing.T) {
	var sockets atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{Subprotocols: []string{"hermes-gateway-v1"}}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "gateway.ready"}})
		if sockets.Add(1) == 1 {
			return // Simulate a gateway restart after the first successful attach.
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/ws"

	g := NewGatewayService()
	statuses := make(chan string, 8)
	g.emitFn = func(name string, data any) {
		if name == "gateway:status" {
			statuses <- data.(string)
		}
	}
	var tickets atomic.Int32
	g.attachFn = func(context.Context) (attachReceipt, error) {
		n := tickets.Add(1)
		return attachReceipt{URL: wsURL, Protocols: []string{"hermes-gateway-v1", "hermes-gateway-ticket.test-" + string(rune('0'+n))}}, nil
	}
	if err := g.ConnectLocal(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"connected", "reconnecting", "connected"} {
		select {
		case got := <-statuses:
			if got != want {
				t.Fatalf("status = %q, want %q", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %q", want)
		}
	}
	if got := tickets.Load(); got != 2 {
		t.Fatalf("attach calls = %d, want fresh ticket on reconnect", got)
	}
	g.Disconnect()
	select {
	case got := <-statuses:
		if got != "disconnected" {
			t.Fatalf("status after manual disconnect = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manual disconnect did not publish status")
	}
}

func TestPendingRPCFailsOnDisconnect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{Subprotocols: []string{"hermes-gateway-v1"}}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "gateway.ready"}})
		_, _, _ = conn.ReadMessage() // Drop the socket with a request in flight.
	}))
	defer server.Close()
	g := NewGatewayService()
	g.emitFn = func(string, any) {}
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/ws"
	if err := g.ConnectTicket(wsURL, []string{"hermes-gateway-v1", "hermes-gateway-ticket.test"}); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := g.Call("runtime.describe", nil); err == nil {
		t.Fatal("in-flight RPC appeared successful after disconnect")
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("in-flight RPC waited instead of failing on disconnect")
	}
	g.mu.Lock()
	remaining := len(g.pending)
	g.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("%d RPCs were left pending after disconnect", remaining)
	}
}

func TestManualDisconnectCancelsLocalReconnect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{Subprotocols: []string{"hermes-gateway-v1"}}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "gateway.ready"}})
	}))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/ws"
	g := NewGatewayService()
	statuses := make(chan string, 8)
	g.emitFn = func(name string, data any) {
		if name == "gateway:status" {
			statuses <- data.(string)
		}
	}
	var calls atomic.Int32
	attachCanceled := make(chan struct{})
	g.attachFn = func(ctx context.Context) (attachReceipt, error) {
		if calls.Add(1) == 1 {
			return attachReceipt{URL: wsURL, Protocols: []string{"hermes-gateway-v1", "hermes-gateway-ticket.initial"}}, nil
		}
		<-ctx.Done()
		close(attachCanceled)
		return attachReceipt{}, errors.New("attach canceled")
	}
	if err := g.ConnectLocal(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"connected", "reconnecting"} {
		select {
		case got := <-statuses:
			if got != want {
				t.Fatalf("status = %q, want %q", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %q", want)
		}
	}
	// Wait for the second attach to begin, then cancel it through the public method.
	deadline := time.After(5 * time.Second)
	for calls.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("reconnect did not mint a new ticket")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	g.Disconnect()
	select {
	case <-attachCanceled:
	case <-time.After(5 * time.Second):
		t.Fatal("manual disconnect did not cancel the attach attempt")
	}
	select {
	case got := <-statuses:
		if got != "disconnected" {
			t.Fatalf("status after manual disconnect = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manual disconnect did not publish status")
	}
}
