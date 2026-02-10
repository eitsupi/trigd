package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"
)

var verbose bool

func main() {
	socketPath := flag.String("socket", "", "Unix socket path for R (auto-generated if empty)")
	httpAddr := flag.String("http", "127.0.0.1:0", "HTTP address for browser (port 0 = auto)")
	webDir := flag.String("web", "", "Static files directory (dev mode; default: embedded)")
	tcpPort := flag.Int("tcp", 0, "TCP port for R connections (Windows; 0 = disabled)")
	flag.BoolVar(&verbose, "v", false, "Verbose logging")
	flag.Parse()

	if !verbose {
		log.SetFlags(0)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Catch signals for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	hub := NewHub()
	go hub.Run()

	// Start R listener (Unix socket or TCP)
	rListener, resolvedSocket, err := createSocketListener(*socketPath, *tcpPort)
	if err != nil {
		log.Fatalf("failed to create R listener: %v", err)
	}
	log.Printf("R listener: %s", resolvedSocket)

	var wg sync.WaitGroup
	done := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		listenR(hub, rListener, done, &wg)
	}()

	// Set up HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})
	mux.Handle("/", staticHandler(*webDir))

	httpListener, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		log.Fatalf("failed to listen HTTP: %v", err)
	}
	httpPort := httpListener.Addr().(*net.TCPAddr).Port
	log.Printf("HTTP server: http://127.0.0.1:%d/", httpPort)

	httpServer := &http.Server{Handler: mux}

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := httpServer.Serve(httpListener); err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	// Write discovery file
	discoveryPaths := writeDiscovery(resolvedSocket, httpPort)

	fmt.Printf("trigd server ready\n")
	fmt.Printf("  R socket:  %s\n", resolvedSocket)
	fmt.Printf("  HTTP:      http://127.0.0.1:%d/\n", httpPort)

	// Wait for shutdown signal
	select {
	case sig := <-sigCh:
		log.Printf("received signal %v, shutting down...", sig)
		cancel()
	case <-ctx.Done():
	}

	// Graceful shutdown sequence
	// 1. Close R listener (stop accepting new R connections)
	rListener.Close()
	close(done)

	// 2. Shutdown HTTP server
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	httpServer.Shutdown(shutdownCtx)

	// 3. Close hub (close all connections)
	hub.Close()

	// 4. Wait for goroutines with timeout
	waitCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(waitCh)
	}()
	select {
	case <-waitCh:
	case <-time.After(5 * time.Second):
		log.Printf("shutdown timeout, forcing exit")
	}

	// 5. Cleanup discovery file and socket
	removeDiscovery(discoveryPaths)
	if runtime.GOOS != "windows" && resolvedSocket != "" {
		os.Remove(resolvedSocket)
	}

	log.Printf("shutdown complete")
}
