package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// Hub routes messages between R sessions and browser clients.
type Hub struct {
	mu               sync.RWMutex
	sessions         map[string]*RSession
	clients          map[*BrowserClient]bool
	metricsRouting   sync.Map // requestID(int) -> sessionID(string)
	registerClient   chan *BrowserClient
	unregisterClient chan *BrowserClient
	broadcastFrame   chan []byte
	done             chan struct{}
	runWg            sync.WaitGroup // tracks Run() goroutine
}

func NewHub() *Hub {
	h := &Hub{
		sessions:         make(map[string]*RSession),
		clients:          make(map[*BrowserClient]bool),
		registerClient:   make(chan *BrowserClient),
		unregisterClient: make(chan *BrowserClient),
		broadcastFrame:   make(chan []byte, 256),
		done:             make(chan struct{}),
	}
	h.runWg.Add(1) // Must be done before go hub.Run()
	return h
}

// Run is the main event loop. Must be launched in its own goroutine after NewHub().
func (h *Hub) Run() {
	defer h.runWg.Done()
	for {
		select {
		case client := <-h.registerClient:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			log.Printf("browser client connected (total: %d)", len(h.clients))

		case client := <-h.unregisterClient:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
			log.Printf("browser client disconnected (total: %d)", len(h.clients))

		case frame := <-h.broadcastFrame:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- frame:
				default:
					// Slow client, drop message
				}
			}
			h.mu.RUnlock()

		case <-h.done:
			return
		}
	}
}

// RegisterSession adds an R session to the hub.
func (h *Hub) RegisterSession(s *RSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sessions[s.id] = s
	log.Printf("R session registered: %s (total: %d)", s.id, len(h.sessions))
}

// UnregisterSession removes an R session from the hub.
func (h *Hub) UnregisterSession(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, id)
	log.Printf("R session unregistered: %s (total: %d)", id, len(h.sessions))
}

// BroadcastToClients sends a message to all browser clients.
func (h *Hub) BroadcastToClients(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		select {
		case client.send <- data:
		default:
		}
	}
}

// BroadcastToR sends a message to all R sessions.
func (h *Hub) BroadcastToR(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, session := range h.sessions {
		if err := session.Send(data); err != nil {
			log.Printf("failed to send to R session %s: %v", session.id, err)
		}
	}
}

// msgType extracts the "type" field from a JSON message.
func msgType(data []byte) string {
	var msg struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return ""
	}
	return msg.Type
}

// HandleRMessage processes a message from an R session.
func (h *Hub) HandleRMessage(session *RSession, data []byte) {
	switch msgType(data) {
	case "frame":
		// Inject sessionId into the plot object if not present
		if session.id != "" && !bytes.Contains(data, []byte(`"sessionId"`)) {
			data = injectSessionID(data, session.id)
		}
		select {
		case h.broadcastFrame <- data:
		default:
		}
		if verbose {
			log.Printf("frame from R session %s (%d bytes)", session.id, len(data))
		}

	case "metrics_request":
		h.handleMetricsRequest(session, data)

	case "close":
		if verbose {
			log.Printf("device close from R session %s", session.id)
		}
		h.BroadcastToClients(data)

	default:
		// Unknown message type, forward to browsers
		h.BroadcastToClients(data)
	}
}

// handleMetricsRequest routes a metrics request from R to browsers,
// setting up a timeout for fallback.
func (h *Hub) handleMetricsRequest(session *RSession, data []byte) {
	// Extract request ID
	var msg struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("failed to parse metrics request: %v", err)
		return
	}

	// If no browsers are connected, immediately send zero-value fallback.
	// R treats zero-value responses the same as a timeout: it falls through
	// to local font metric approximations, but without the 500ms poll wait.
	//
	// Note: there is a benign TOCTOU race — a browser could connect between
	// the unlock and the send. The only consequence is one request using
	// local approximation instead of browser-measured metrics, which is
	// identical to the 2s timeout fallback behavior.
	h.mu.RLock()
	nClients := len(h.clients)
	h.mu.RUnlock()

	if nClients == 0 {
		fallback := fmt.Sprintf(`{"type":"metrics_response","id":%d,"width":0,"ascent":0,"descent":0}`, msg.ID)
		if err := session.Send([]byte(fallback)); err != nil {
			log.Printf("failed to send metrics fallback to R session %s: %v", session.id, err)
		}
		return
	}

	// Store routing: requestID -> sessionID
	h.metricsRouting.Store(msg.ID, session.id)

	// Forward to browsers
	h.BroadcastToClients(data)

	// Set timeout: if no response in 2s, send zero-value fallback
	time.AfterFunc(2*time.Second, func() {
		if _, loaded := h.metricsRouting.LoadAndDelete(msg.ID); loaded {
			// No response received, send fallback
			fallback := fmt.Sprintf(`{"type":"metrics_response","id":%d,"width":0,"ascent":0,"descent":0}`, msg.ID)
			if err := session.Send([]byte(fallback)); err != nil {
				log.Printf("failed to send metrics fallback to R session %s: %v", session.id, err)
			}
			if verbose {
				log.Printf("metrics timeout for request %d, sent fallback to session %s", msg.ID, session.id)
			}
		}
	})
}

// HandleMetricsResponse routes a metrics response from a browser to the originating R session.
func (h *Hub) HandleMetricsResponse(data []byte) {
	var msg struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("failed to parse metrics response: %v", err)
		return
	}

	val, loaded := h.metricsRouting.LoadAndDelete(msg.ID)
	if !loaded {
		// Already timed out or duplicate
		return
	}

	sessionID, ok := val.(string)
	if !ok {
		return
	}

	h.mu.RLock()
	session, exists := h.sessions[sessionID]
	h.mu.RUnlock()

	if exists {
		if err := session.Send(data); err != nil {
			log.Printf("failed to send metrics response to R session %s: %v", sessionID, err)
		}
	}
}

// Close shuts down the hub and all connections.
// It stops Run() first and waits for it to exit, then cleans up.
func (h *Hub) Close() {
	close(h.done)

	// Drain remaining channel messages so Run() can exit if it's
	// blocked trying to send on registerClient/unregisterClient.
	// Once done is closed, Run() returns on next select iteration.
	// Give it a moment to exit before we clean up.
	h.runWg.Wait()

	h.mu.Lock()
	defer h.mu.Unlock()

	for client := range h.clients {
		close(client.send)
		client.conn.Close()
		delete(h.clients, client)
	}

	for id, session := range h.sessions {
		session.conn.Close()
		delete(h.sessions, id)
	}
}

// injectSessionID adds sessionId to the plot object in a frame message.
func injectSessionID(data []byte, sessionID string) []byte {
	// Find "plot":{  and insert "sessionId":"..." after the opening brace
	plotIdx := bytes.Index(data, []byte(`"plot":{`))
	if plotIdx < 0 {
		plotIdx = bytes.Index(data, []byte(`"plot": {`))
		if plotIdx < 0 {
			return data
		}
	}
	braceIdx := bytes.IndexByte(data[plotIdx:], '{')
	if braceIdx < 0 {
		return data
	}
	insertPos := plotIdx + braceIdx + 1

	// JSON-encode the session ID to prevent injection
	escaped, err := json.Marshal(sessionID)
	if err != nil {
		return data
	}
	insert := append([]byte(`"sessionId":`), escaped...)
	insert = append(insert, ',')

	result := make([]byte, 0, len(data)+len(insert))
	result = append(result, data[:insertPos]...)
	result = append(result, insert...)
	result = append(result, data[insertPos:]...)
	return result
}
