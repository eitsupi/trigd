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
}

func NewHub() *Hub {
	return &Hub{
		sessions:         make(map[string]*RSession),
		clients:          make(map[*BrowserClient]bool),
		registerClient:   make(chan *BrowserClient),
		unregisterClient: make(chan *BrowserClient),
		broadcastFrame:   make(chan []byte, 256),
		done:             make(chan struct{}),
	}
}

// Run is the main event loop. It must be called in its own goroutine.
func (h *Hub) Run() {
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

// HandleRMessage processes a message from an R session.
func (h *Hub) HandleRMessage(session *RSession, data []byte) {
	// Fast path: detect message type without full JSON parse
	if bytes.Contains(data, []byte(`"type":"frame"`)) || bytes.Contains(data, []byte(`"type": "frame"`)) {
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
		return
	}

	if bytes.Contains(data, []byte(`"type":"metrics_request"`)) || bytes.Contains(data, []byte(`"type": "metrics_request"`)) {
		h.handleMetricsRequest(session, data)
		return
	}

	if bytes.Contains(data, []byte(`"type":"close"`)) || bytes.Contains(data, []byte(`"type": "close"`)) {
		if verbose {
			log.Printf("device close from R session %s", session.id)
		}
		// Forward to browsers
		h.BroadcastToClients(data)
		return
	}

	// Unknown message type, forward to browsers
	h.BroadcastToClients(data)
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
func (h *Hub) Close() {
	close(h.done)

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
	insert := []byte(fmt.Sprintf(`"sessionId":"%s",`, sessionID))
	result := make([]byte, 0, len(data)+len(insert))
	result = append(result, data[:insertPos]...)
	result = append(result, insert...)
	result = append(result, data[insertPos:]...)
	return result
}
