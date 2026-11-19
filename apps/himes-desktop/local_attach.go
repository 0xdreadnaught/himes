package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const attachOutputLimit = 64 * 1024

type attachReceipt struct {
	URL       string   `json:"url"`
	Protocols []string `json:"protocols"`
}

type limitedOutput struct {
	buf bytes.Buffer
	max int
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	if w.buf.Len()+len(p) > w.max {
		return 0, errors.New("Hermes attach output exceeded limit")
	}
	return w.buf.Write(p)
}

func localHermesCLI() (string, error) {
	if runtime.GOOS == "windows" {
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			candidate := filepath.Join(localAppData, "hermes", "bin", "hermes.exe")
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate, nil
			}
		}
	}
	path, err := exec.LookPath("hermes")
	if err != nil {
		return "", errors.New("Hermes CLI was not found; install Hermes locally before connecting")
	}
	return path, nil
}

func parseAttachReceipt(data []byte) (attachReceipt, error) {
	var receipt attachReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return receipt, errors.New("Hermes CLI returned an unreadable attach response")
	}
	if strings.TrimSpace(receipt.URL) == "" || len(receipt.Protocols) == 0 {
		return receipt, errors.New("Hermes CLI did not return an attachable gateway")
	}
	if _, err := validateDirectWSURL(receipt.URL); err != nil {
		return receipt, errors.New("Hermes CLI returned an invalid gateway URL")
	}
	validProtocol := false
	for _, protocol := range receipt.Protocols {
		if protocol == "hermes-gateway-v1" {
			validProtocol = true
		}
	}
	if !validProtocol {
		return receipt, errors.New("Hermes CLI returned an unexpected gateway protocol")
	}
	return receipt, nil
}

func attachLocalGateway(parent context.Context) (attachReceipt, error) {
	cli, err := localHermesCLI()
	if err != nil {
		return attachReceipt{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 55*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cli, "gateway", "attach", "--start", "--timeout", "45", "--json")
	hideChildWindow(cmd)
	var output limitedOutput
	output.max = attachOutputLimit
	cmd.Stdout = &output
	cmd.Stderr = io.Discard // CLI diagnostics can contain private paths; never surface tickets.
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return attachReceipt{}, errors.New("Hermes gateway startup timed out or was canceled")
		}
		return attachReceipt{}, errors.New("Hermes could not start or attach its local gateway")
	}
	defer clear(output.buf.Bytes())
	return parseAttachReceipt(output.buf.Bytes())
}

func (g *GatewayService) connectLocalOnce(ctx context.Context, intent uint64) error {
	attach := g.attachFn
	if attach == nil {
		attach = attachLocalGateway
	}
	receipt, err := attach(ctx)
	if err != nil {
		return err
	}
	validated, err := validateDirectWSURL(receipt.URL)
	if err != nil {
		return errors.New("Hermes CLI returned an invalid gateway URL")
	}
	if len(receipt.Protocols) < 2 || receipt.Protocols[0] != "hermes-gateway-v1" || !strings.HasPrefix(receipt.Protocols[1], "hermes-gateway-ticket.") {
		return errors.New("Hermes CLI returned an invalid gateway protocol")
	}
	return g.dial(validated, receipt.Protocols, intent)
}

// ConnectLocal starts or discovers the user's local gateway and consumes a
// one-use ticket entirely inside this process. Its credentials are never
// returned to the renderer or written to logs.
func (g *GatewayService) ConnectLocal() error {
	intent := g.beginConnection(true)
	err := g.connectLocalOnce(context.Background(), intent)
	if err != nil {
		g.connectionFailed(intent)
	}
	return err
}

// reconnectLocal obtains a new ticket for each attempt. Single-use tickets
// cannot be replayed after a broken WebSocket.
func (g *GatewayService) reconnectLocal(ctx context.Context, intent uint64) {
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			pause := time.NewTimer(time.Duration(attempt*2) * time.Second)
			select {
			case <-ctx.Done():
				pause.Stop()
				return
			case <-pause.C:
			}
		}
		if ctx.Err() != nil {
			return
		}
		if err := g.connectLocalOnce(ctx, intent); err == nil {
			return
		}
	}
	g.mu.Lock()
	stillWanted := g.intent == intent && g.reconnecting && g.conn == nil
	if stillWanted {
		g.reconnecting = false
		g.reconnectCancel = nil
		g.local = false
	}
	g.mu.Unlock()
	if stillWanted {
		g.emit("gateway:status", "disconnected")
	}
}
