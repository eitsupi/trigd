package main

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
)

//go:embed web
var webFiles embed.FS

// staticHandler returns an http.Handler for serving static files.
// If webDir is non-empty, files are served from disk (dev mode).
// Otherwise, embedded files are used.
func staticHandler(webDir string) http.Handler {
	var fileSystem fs.FS
	if webDir != "" {
		fileSystem = os.DirFS(webDir)
	} else {
		var err error
		fileSystem, err = fs.Sub(webFiles, "web")
		if err != nil {
			panic("failed to access embedded web files: " + err.Error())
		}
	}
	return http.FileServer(http.FS(fileSystem))
}
