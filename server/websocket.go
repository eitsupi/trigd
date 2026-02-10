package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 64 * 1024
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // Local server, allow all origins
	},
}

// BrowserClient represents a connected browser.
type BrowserClient struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
}

// serveWs handles WebSocket upgrade requests from browsers.
func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	client := &BrowserClient{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 256),
	}

	hub.registerClient <- client

	go client.writePump()
	go client.readPump()
}

// readPump reads messages from the browser WebSocket.
func (c *BrowserClient) readPump() {
	defer func() {
		c.hub.unregisterClient <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("websocket read error: %v", err)
			}
			return
		}

		c.handleBrowserMessage(message)
	}
}

// writePump sends messages to the browser WebSocket.
func (c *BrowserClient) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleBrowserMessage processes a message from the browser.
func (c *BrowserClient) handleBrowserMessage(data []byte) {
	switch msgType(data) {
	case "resize":
		c.hub.BroadcastToR(data)
		if verbose {
			log.Printf("resize from browser (%d bytes)", len(data))
		}

	case "metrics_response":
		c.hub.HandleMetricsResponse(data)

	default:
		if verbose {
			log.Printf("unknown browser message: %s", data)
		}
	}
}
