package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// RSession represents a connected R process.
type RSession struct {
	id            string
	conn          net.Conn
	hub           *Hub
	mu            sync.Mutex
	writer        *bufio.Writer
	resizePending atomic.Bool
	lastResizeW   atomic.Int32
	lastResizeH   atomic.Int32
}

// Send writes data followed by a newline to the R session.
func (s *RSession) Send(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.writer.Write(data); err != nil {
		return err
	}
	if err := s.writer.WriteByte('\n'); err != nil {
		return err
	}
	return s.writer.Flush()
}

var sessionCounter atomic.Int64

// listenR starts listening for R connections on the given listener.
func listenR(hub *Hub, listener net.Listener, done <-chan struct{}, wg *sync.WaitGroup) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-done:
				return
			default:
			}
			// If listener was closed, stop accepting
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept error: %v", err)
			continue
		}

		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			handleRConnection(hub, c)
		}(conn)
	}
}

// handleRConnection reads NDJSON messages from an R connection.
func handleRConnection(hub *Hub, conn net.Conn) {
	defer conn.Close()

	n := sessionCounter.Add(1)
	sessionID := fmt.Sprintf("conn-%d", n)

	session := &RSession{
		id:     sessionID,
		conn:   conn,
		hub:    hub,
		writer: bufio.NewWriter(conn),
	}
	hub.RegisterSession(session)
	defer func() { hub.UnregisterSession(session.id) }()

	log.Printf("R connection accepted: %s from %s", sessionID, conn.RemoteAddr())

	scanner := bufio.NewScanner(conn)
	// 4MB buffer for large raster frames
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	firstMessage := true
	for scanner.Scan() {
		data := scanner.Bytes()
		if len(data) == 0 {
			continue
		}

		// Copy data since scanner reuses its buffer
		msg := make([]byte, len(data))
		copy(msg, data)

		// Extract session ID from first frame's plot.sessionId
		if firstMessage {
			firstMessage = false
			if id := extractSessionID(msg); id != "" {
				oldID := session.id
				session.id = id
				hub.mu.Lock()
				delete(hub.sessions, oldID)
				hub.sessions[id] = session
				hub.mu.Unlock()
				log.Printf("R session %s identified as %s", oldID, id)
			}
		}

		hub.HandleRMessage(session, msg)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("R session %s read error: %v", session.id, err)
	} else {
		log.Printf("R session %s disconnected", session.id)
	}
}

// extractSessionID extracts the plot.sessionId from a message.
func extractSessionID(data []byte) string {
	var msg struct {
		Plot struct {
			SessionID string `json:"sessionId"`
		} `json:"plot"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return ""
	}
	return msg.Plot.SessionID
}

// createSocketListener creates a Unix domain socket or TCP listener for R connections.
func createSocketListener(socketPath string, tcpPort int) (net.Listener, string, error) {
	if runtime.GOOS == "windows" || tcpPort > 0 {
		return createTCPListener(tcpPort)
	}
	return createUnixListener(socketPath)
}

func createUnixListener(socketPath string) (net.Listener, string, error) {
	if socketPath == "" {
		token := make([]byte, 8)
		if _, err := rand.Read(token); err != nil {
			return nil, "", fmt.Errorf("generate random token: %w", err)
		}
		socketPath = filepath.Join(os.TempDir(), fmt.Sprintf("trigd-%s.sock", hex.EncodeToString(token)))
	}

	// Check for stale socket
	if _, err := os.Stat(socketPath); err == nil {
		conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil, "", fmt.Errorf("socket %s is in use by another process", socketPath)
		}
		// Stale socket, remove it
		if err := os.Remove(socketPath); err != nil {
			return nil, "", fmt.Errorf("remove stale socket: %w", err)
		}
	}

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, "", fmt.Errorf("listen unix %s: %w", socketPath, err)
	}

	return listener, socketPath, nil
}

func createTCPListener(port int) (net.Listener, string, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, "", fmt.Errorf("listen tcp %s: %w", addr, err)
	}
	actualAddr := listener.Addr().(*net.TCPAddr)
	socketPath := fmt.Sprintf("tcp:%d", actualAddr.Port)
	return listener, socketPath, nil
}
