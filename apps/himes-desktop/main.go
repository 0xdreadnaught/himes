package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var frontendAssets embed.FS

func webviewDataPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	if base == "" {
		return ""
	}
	return filepath.Join(base, "Himes", "WebView2")
}

func main() {
	gateway := NewGatewayService()
	app := application.New(application.Options{
		Name:        "Himes",
		Description: "A lightweight desktop client for the Himes agent",
		Windows: application.WindowsOptions{
			WndClass:            "HimesDesktopWindow",
			WebviewUserDataPath: webviewDataPath(),
		},
		Linux: application.LinuxOptions{ApplicationID: "org.himes.Desktop"},
		Services: []application.Service{
			application.NewService(gateway),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(frontendAssets),
		},
	})
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:      "main",
		Title:     "Himes",
		Width:     1100,
		Height:    760,
		MinWidth:  760,
		MinHeight: 520,
	})
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
