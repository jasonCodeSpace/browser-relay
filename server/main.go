package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type relayState struct {
	mu        sync.RWMutex
	clients   map[*clientConn]struct{}
	extension *clientConn
	inflight  map[string]*inflightRequest
}

type inflightRequest struct {
	client *clientConn
	timer  *time.Timer
}

type clientConn struct {
	conn   *websocket.Conn
	mu     sync.Mutex
	role   string
	closed bool
}

type wsMessage struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Event  string          `json:"event,omitempty"`
	OK     bool            `json:"ok,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result any             `json:"result,omitempty"`
	Error  any             `json:"error,omitempty"`
	Data   any             `json:"data,omitempty"`
}

type errorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

func main() {
	host := envOr("HOST", "127.0.0.1")
	port := envInt("PORT", 47892)
	requestTimeout := time.Duration(envInt("REQUEST_TIMEOUT_MS", 30000)) * time.Millisecond

	state := &relayState{
		clients:  make(map[*clientConn]struct{}),
		inflight: make(map[string]*inflightRequest),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		state.mu.RLock()
		defer state.mu.RUnlock()

		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                 true,
			"extensionConnected": state.extension != nil,
			"clients":            len(state.clients),
		})
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(state, requestTimeout, w, r)
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", host, port),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Browser Relay server listening on ws://%s:%d/ws", host, port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func handleWebSocket(state *relayState, requestTimeout time.Duration, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	role := parseRole(r.URL)
	client := &clientConn{
		conn: conn,
		role: role,
	}

	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	})

	if role == "extension" {
		var previous *clientConn
		state.mu.Lock()
		previous = state.extension
		state.extension = client
		state.mu.Unlock()

		if previous != nil && previous != client {
			_ = previous.close(websocket.CloseServiceRestart, "Replaced by a new extension connection.")
		}

		_ = client.send(wsMessage{
			Type:  "event",
			Event: "relay.connected",
			Data:  map[string]any{"role": "server"},
		})
		state.broadcast(wsMessage{
			Type:  "event",
			Event: "relay.connected",
			Data:  map[string]any{"role": "extension"},
		})
	} else {
		state.mu.Lock()
		state.clients[client] = struct{}{}
		state.mu.Unlock()
		_ = client.send(wsMessage{
			Type:  "event",
			Event: "relay.connected",
			Data:  map[string]any{"role": "client"},
		})
	}

	go keepAlive(client)

	for {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			cleanupSocket(state, client)
			return
		}

		if client.role == "extension" {
			handleExtensionMessage(state, msg)
			continue
		}

		handleClientMessage(state, requestTimeout, client, msg)
	}
}

func handleClientMessage(state *relayState, requestTimeout time.Duration, client *clientConn, msg wsMessage) {
	if msg.Type != "request" || msg.ID == "" || msg.Method == "" {
		failClientRequest(client, msg.ID, "BAD_REQUEST", "Invalid request payload.")
		return
	}

	if msg.Method == "Relay.status" {
		state.mu.RLock()
		defer state.mu.RUnlock()

		_ = client.send(wsMessage{
			Type: "response",
			ID:   msg.ID,
			OK:   true,
			Result: map[string]any{
				"extensionConnected": state.extension != nil,
				"clients":            len(state.clients),
				"inflight":           len(state.inflight),
			},
		})
		return
	}

	state.mu.Lock()
	extension := state.extension
	if extension == nil {
		state.mu.Unlock()
		failClientRequest(client, msg.ID, "NOT_CONNECTED", "No extension is connected.")
		return
	}

	timer := time.AfterFunc(requestTimeout, func() {
		state.mu.Lock()
		entry, ok := state.inflight[msg.ID]
		if ok {
			delete(state.inflight, msg.ID)
		}
		state.mu.Unlock()
		if ok {
			failClientRequest(entry.client, msg.ID, "TIMEOUT", fmt.Sprintf("Request timed out after %dms.", requestTimeout.Milliseconds()))
		}
	})

	state.inflight[msg.ID] = &inflightRequest{
		client: client,
		timer:  timer,
	}
	state.mu.Unlock()

	if err := extension.send(msg); err != nil {
		timer.Stop()
		state.mu.Lock()
		delete(state.inflight, msg.ID)
		state.mu.Unlock()
		failClientRequest(client, msg.ID, "EXTENSION_DISCONNECTED", "The extension disconnected before replying.")
	}
}

func handleExtensionMessage(state *relayState, msg wsMessage) {
	if msg.Type == "response" && msg.ID != "" {
		state.mu.Lock()
		entry, ok := state.inflight[msg.ID]
		if ok {
			delete(state.inflight, msg.ID)
		}
		state.mu.Unlock()

		if ok {
			entry.timer.Stop()
			_ = entry.client.send(msg)
		}
		return
	}

	if msg.Type == "event" && msg.Event != "" {
		state.broadcast(msg)
	}
}

func cleanupSocket(state *relayState, client *clientConn) {
	_ = client.close(websocket.CloseNormalClosure, "closing")

	state.mu.Lock()
	defer state.mu.Unlock()

	if state.extension == client {
		state.extension = nil
		for id, entry := range state.inflight {
			entry.timer.Stop()
			_ = entry.client.send(wsMessage{
				Type: "response",
				ID:   id,
				OK:   false,
				Error: errorPayload{
					Code:    "EXTENSION_DISCONNECTED",
					Message: "The extension disconnected before replying.",
				},
			})
		}
		state.inflight = make(map[string]*inflightRequest)
		go state.broadcast(wsMessage{
			Type:  "event",
			Event: "relay.disconnected",
			Data:  map[string]any{"role": "extension"},
		})
	}

	delete(state.clients, client)
	for id, entry := range state.inflight {
		if entry.client == client {
			entry.timer.Stop()
			delete(state.inflight, id)
		}
	}
}

func (state *relayState) broadcast(msg wsMessage) {
	state.mu.RLock()
	defer state.mu.RUnlock()

	for client := range state.clients {
		_ = client.send(msg)
	}
}

func (client *clientConn) send(msg wsMessage) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closed {
		return errors.New("socket closed")
	}
	return client.conn.WriteJSON(msg)
}

func (client *clientConn) close(code int, reason string) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.closed {
		return nil
	}
	client.closed = true
	message := websocket.FormatCloseMessage(code, reason)
	_ = client.conn.WriteControl(websocket.CloseMessage, message, time.Now().Add(time.Second))
	return client.conn.Close()
}

func failClientRequest(client *clientConn, id, code, message string) {
	if id == "" {
		id = "unknown"
	}
	_ = client.send(wsMessage{
		Type: "response",
		ID:   id,
		OK:   false,
		Error: errorPayload{
			Code:    code,
			Message: message,
		},
	})
}

func keepAlive(client *clientConn) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		client.mu.Lock()
		closed := client.closed
		client.mu.Unlock()
		if closed {
			return
		}

		if err := client.conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(time.Second)); err != nil {
			_ = client.close(websocket.CloseGoingAway, "ping failed")
			return
		}
	}
}

func parseRole(u *url.URL) string {
	role := u.Query().Get("role")
	if role == "" {
		return "client"
	}
	return role
}

func envOr(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
