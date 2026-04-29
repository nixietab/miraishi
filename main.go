package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/text/language"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024
)

// Configuration

type Config struct {
	Port              int    `json:"port"`
	Realm             string `json:"realm"`
	TurnUser          string `json:"turn_user"`
	TurnPass          string `json:"turn_pass"`
	TurnSecret        string `json:"turn_secret"`
	PublicDomain      string `json:"public_domain"`
	MaxRooms          int    `json:"max_rooms"`
	MaxViewersPerRoom int    `json:"max_viewers_per_room"`
}

var globalConfig Config

func loadConfig() {
	data, err := os.ReadFile("config.json")
	if err != nil {
		log.Println("Warning: Could not read config.json, using defaults")
		globalConfig = Config{
			Port:              8080,
			Realm:             "miraishi",
			TurnUser:          "miraishi",
			TurnPass:          "MUST_CHANGE_FOR_SECURITY",
			TurnSecret:        "",
			PublicDomain:      "localhost",
			MaxRooms:          100,
			MaxViewersPerRoom: 200,
		}
		return
	}
	if err := json.Unmarshal(data, &globalConfig); err != nil {
		log.Fatalf("Error parsing config.json: %v", err)
	}
	if globalConfig.MaxRooms == 0 {
		globalConfig.MaxRooms = 100
	}
	if globalConfig.MaxViewersPerRoom == 0 {
		globalConfig.MaxViewersPerRoom = 200
	}
}

// Types and states

type GlobalState struct {
	fileCache [][]byte
	matcher   language.Matcher
	rooms     map[string]*Room
	roomLock  sync.Mutex
}

var state = GlobalState{
	rooms: make(map[string]*Room),
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // Allow non-browser clients
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		// Allow localhost and the configured public domain
		return u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || (globalConfig.PublicDomain != "" && u.Hostname() == globalConfig.PublicDomain)
	},
}

// SafeConn is a thread-safe wrapper for websocket.Conn
type SafeConn struct {
	Conn *websocket.Conn
	mu   sync.Mutex
}

func (sc *SafeConn) WriteMessage(messageType int, data []byte) error {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.Conn.SetWriteDeadline(time.Now().Add(writeWait))
	return sc.Conn.WriteMessage(messageType, data)
}

func (sc *SafeConn) Close() error {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.Conn.Close()
}

// Signaling types

type Message struct {
	Type     string          `json:"type"`
	RoomID   string          `json:"roomId,omitempty"`
	ViewerID string          `json:"viewerId,omitempty"`
	Kind     string          `json:"kind,omitempty"`
	Message  json.RawMessage `json:"message,omitempty"`
}

type Room struct {
	ID          string
	Broadcaster *SafeConn
	Viewers     map[string]*SafeConn
	Counter     int
	Lock        sync.Mutex
	OnClose     func()
	Closed      bool
}

// Room logic

func (r *Room) AddViewer(conn *SafeConn) {
	r.Lock.Lock()
	if r.Closed {
		r.Lock.Unlock()
		conn.Close()
		return
	}
	if len(r.Viewers) >= globalConfig.MaxViewersPerRoom {
		r.Lock.Unlock()
		log.Printf("[FAILED] Room %s: Viewer limit reached", r.ID)
		conn.Close()
		return
	}
	id := fmt.Sprintf("%d", r.Counter)
	r.Counter++
	r.Viewers[id] = conn
	r.Lock.Unlock()

	log.Printf("[OK] Room %s: Viewer %s joined", r.ID, id)

	r.sendMessage(conn, Message{Type: "view"})
	r.broadcastToBroadcaster(Message{Type: "viewer", ViewerID: id})

	go r.handleViewer(id, conn)
}

func (r *Room) handleViewer(id string, conn *SafeConn) {
	defer func() {
		r.Lock.Lock()
		delete(r.Viewers, id)
		r.Lock.Unlock()
		conn.Close()
		log.Printf("[OK] Room %s: Viewer %s left", r.ID, id)
		r.broadcastToBroadcaster(Message{Type: "viewerdisconnected", ViewerID: id})
	}()

	conn.Conn.SetReadLimit(maxMessageSize)
	conn.Conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.Conn.SetPongHandler(func(string) error { conn.Conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })

	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for range ticker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	for {
		_, payload, err := conn.Conn.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("[FAILED] Viewer %s: Invalid message: %v", id, err)
			continue
		}

		if msg.Type == "webrtcviewer" {
			r.broadcastToBroadcaster(Message{
				Type:     "webrtcbroadcaster",
				ViewerID: id,
				Kind:     msg.Kind,
				Message:  msg.Message,
			})
		}
	}
}

func (r *Room) handleBroadcaster() {
	defer func() {
		r.Close()
	}()

	r.sendMessage(r.Broadcaster, Message{Type: "broadcast"})

	r.Broadcaster.Conn.SetReadLimit(maxMessageSize)
	r.Broadcaster.Conn.SetReadDeadline(time.Now().Add(pongWait))
	r.Broadcaster.Conn.SetPongHandler(func(string) error { r.Broadcaster.Conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })

	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for range ticker.C {
			if err := r.Broadcaster.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	for {
		_, payload, err := r.Broadcaster.Conn.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("[FAILED] Room %s: Invalid broadcaster message: %v", r.ID, err)
			continue
		}

		switch msg.Type {
		case "webrtcbroadcaster":
			r.Lock.Lock()
			viewer, ok := r.Viewers[msg.ViewerID]
			r.Lock.Unlock()
			if ok {
				r.sendMessage(viewer, Message{
					Type:    "webrtcviewer",
					Kind:    msg.Kind,
					Message: msg.Message,
				})
			}
		case "requestviewers":
			r.Lock.Lock()
			for vid := range r.Viewers {
				r.sendMessage(r.Broadcaster, Message{Type: "viewer", ViewerID: vid})
			}
			r.Lock.Unlock()
		}
	}
}

func (r *Room) Close() {
	r.Lock.Lock()
	if r.Closed {
		r.Lock.Unlock()
		return
	}
	r.Closed = true
	defer r.Lock.Unlock()

	log.Printf("[OK] Room %s: Closed", r.ID)
	for id, conn := range r.Viewers {
		r.sendMessage(conn, Message{Type: "broadcasterdisconnected"})
		conn.Close()
		delete(r.Viewers, id)
	}
	r.Broadcaster.Close()
	if r.OnClose != nil {
		r.OnClose()
	}
}

func (r *Room) sendMessage(conn *SafeConn, msg Message) {
	data, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, data)
}

func (r *Room) broadcastToBroadcaster(msg Message) {
	r.sendMessage(r.Broadcaster, msg)
}

// Server common handlers

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[FAILED] WS Upgrade: %v", err)
		return
	}

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	_, payload, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return
	}

	var msg Message
	if err := json.Unmarshal(payload, &msg); err != nil || msg.Type != "join" || msg.RoomID == "" || len(msg.RoomID) > 100 {
		conn.Close()
		return
	}

	roomID := strings.ToLower(msg.RoomID)
	safeConn := &SafeConn{Conn: conn}

	state.roomLock.Lock()
	room, ok := state.rooms[roomID]
	if !ok {
		if len(state.rooms) >= globalConfig.MaxRooms {
			state.roomLock.Unlock()
			log.Printf("[FAILED] Room limit reached, rejecting %s", roomID)
			safeConn.Close()
			return
		}
		room = &Room{
			ID:          roomID,
			Broadcaster: safeConn,
			Viewers:     make(map[string]*SafeConn),
			OnClose: func() {
				state.roomLock.Lock()
				delete(state.rooms, roomID)
				state.roomLock.Unlock()
			},
		}
		state.rooms[roomID] = room
		state.roomLock.Unlock()
		log.Printf("[OK] Room %s: Created", roomID)
		go room.handleBroadcaster()
	} else {
		state.roomLock.Unlock()
		room.AddViewer(safeConn)
	}
}

func fetchTranslations() ([][]byte, language.Matcher) {
	filePaths, err := filepath.Glob("./translations/*.html")
	if err != nil {
		panic(err)
	}

	defaultPath := "translations/en.html"
	filePaths = append([]string{defaultPath}, filePaths...)

	var fileCache [][]byte
	var languageTags []language.Tag
	seen := make(map[string]bool)

	for _, filePath := range filePaths {
		if seen[filePath] {
			continue
		}
		seen[filePath] = true

		content, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}

		baseName := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
		tag, err := language.Parse(baseName)
		if err != nil {
			continue
		}

		fileCache = append(fileCache, content)
		languageTags = append(languageTags, tag)
	}

	if len(fileCache) == 0 {
		log.Fatal("Error: No translation files found in ./translations/")
	}

	return fileCache, language.NewMatcher(languageTags)
}

func generateTURNCredentials(secret string, user string) (string, string) {
	timestamp := time.Now().Add(24 * time.Hour).Unix()
	username := fmt.Sprintf("%d:%s", timestamp, user)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return username, password
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	username := globalConfig.TurnUser
	password := globalConfig.TurnPass

	if globalConfig.TurnSecret != "" {
		username, password = generateTURNCredentials(globalConfig.TurnSecret, globalConfig.TurnUser)
	}

	iceConfig := map[string]interface{}{
		"iceServers": []map[string]interface{}{
			{"urls": "stun:" + globalConfig.PublicDomain},
			{
				"urls":       "turn:" + globalConfig.PublicDomain,
				"username":   username,
				"credential": password,
			},
		},
		"iceCandidatePoolSize": 8,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(iceConfig)
}

func mainHandler(fileServer http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") == "websocket" {
			handleWebSocket(w, r)
			return
		}

		path := r.URL.Path
		if path == "/config" {
			handleConfig(w, r)
			return
		}

		if path == "/" || path == "/index.html" {
			acceptLanguageHeader := r.Header.Get("Accept-Language")
			tags, _, _ := language.ParseAcceptLanguage(acceptLanguageHeader)
			_, idx, _ := state.matcher.Match(tags...)
			fileContent := state.fileCache[idx]

			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(fileContent))
		} else {
			fileServer.ServeHTTP(w, r)
		}
	}
}

func main() {
	loadConfig()
	state.fileCache, state.matcher = fetchTranslations()

	fileServer := http.FileServer(http.Dir("./static"))

	addr := fmt.Sprintf(":%d", globalConfig.Port)
	server := &http.Server{
		Addr:         addr,
		Handler:      mainHandler(fileServer),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	log.Printf("[OK] Server listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[FAILED] Server: %v", err)
	}
}
