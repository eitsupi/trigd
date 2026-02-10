package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

const discoveryFileName = "trigd-discovery.json"

// writeDiscovery atomically writes the discovery file so R can find the server.
// It writes to $TMPDIR and also to /tmp if different (matching transport.c search paths).
func writeDiscovery(socketPath string, httpPort int) []string {
	disc := struct {
		SocketPath string `json:"socketPath"`
		HTTPPort   int    `json:"httpPort"`
		PID        int    `json:"pid"`
	}{socketPath, httpPort, os.Getpid()}
	content, _ := json.Marshal(disc)

	var written []string
	locations := discoveryLocations()

	for _, loc := range locations {
		if err := atomicWrite(loc, content); err != nil {
			log.Printf("warning: failed to write discovery to %s: %v", loc, err)
			continue
		}
		written = append(written, loc)
		log.Printf("wrote discovery file: %s", loc)
	}

	return written
}

// removeDiscovery removes all discovery files.
func removeDiscovery(paths []string) {
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			log.Printf("warning: failed to remove discovery file %s: %v", p, err)
		}
	}
}

// discoveryLocations returns the paths where discovery files should be written.
func discoveryLocations() []string {
	tmpdir := os.TempDir()
	locations := []string{filepath.Join(tmpdir, discoveryFileName)}

	if runtime.GOOS != "windows" {
		// Also write to /tmp if it's different from $TMPDIR
		if tmpdir != "/tmp" {
			locations = append(locations, filepath.Join("/tmp", discoveryFileName))
		}
	}

	return locations
}

// atomicWrite writes data to a file atomically via temp file + rename.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".trigd-discovery-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
