package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// 首帧认证必须在 5 秒内送达，避免未认证连接长期占用。
	watchAuthTimeout = 5 * time.Second
	// 应用层心跳：浏览器 JS 看不到 WebSocket 控制帧，所以用文本帧让双方都能探活。
	watchPingInterval = 25 * time.Second
	// 超过 70 秒没有收到任何客户端消息（含 pong）即判定连接已死。
	watchReadTimeout  = 70 * time.Second
	watchWriteTimeout = 10 * time.Second
	// 定期重连可让过期 token 尽快失效，也避免长连接无限期滞留。
	watchMaxLifetime  = 30 * time.Minute
	watchMessageLimit = 1024
	watchSendBuffer   = 8
	// 包含尚未通过首帧认证的连接，避免公网被大量握手拖垮；
	// 更细的按 IP 限流应由反向代理负责。
	watchMaxConnections = 2048
)

var watchConnections atomic.Int64

// 服务端只广播「有变更」这一事实，不携带会话内容。
// 客户端收到后复用既有的 /api/changes 增量拉取链路，避免维护第二套同步逻辑。
type watchMessage struct {
	Type  string `json:"type"`
	Rev   int64  `json:"rev,omitempty"`
	Token string `json:"token,omitempty"`
	// ClientID 由客户端在首帧认证时上报；服务端据此跳过向写入方回推自己的变更。
	ClientID string `json:"clientId,omitempty"`
}

// ready / changed 必须带 rev，即使新账号的游标是 0 也不能省略。
type watchRevMessage struct {
	Type string `json:"type"`
	Rev  int64  `json:"rev"`
}

var (
	watchPingMsg         = mustWatchMessage(watchMessage{Type: "ping"})
	watchAuthRequiredMsg = mustWatchMessage(watchMessage{Type: "auth_required"})
	watchServerErrorMsg  = mustWatchMessage(watchMessage{Type: "error"})
)

func mustWatchMessage(value watchMessage) []byte {
	return marshalWatch(value)
}

func marshalWatch(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func watchChangedMessage(rev int64) []byte {
	return marshalWatch(watchRevMessage{Type: "changed", Rev: rev})
}

func watchReadyMessage(rev int64) []byte {
	return marshalWatch(watchRevMessage{Type: "ready", Rev: rev})
}

// watchClient 是一个已认证的订阅连接。send 不关闭，写协程靠 done 退出，
// 这样广播方即使碰上正在断开的连接也不会触发 send on closed channel。
type watchClient struct {
	conn      *websocket.Conn
	userID    string
	tokenHash string
	clientID  string
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func (c *watchClient) shutdown() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

func (c *watchClient) enqueue(msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

func (c *watchClient) write(kind int, msg []byte) bool {
	if err := c.conn.SetWriteDeadline(time.Now().Add(watchWriteTimeout)); err != nil {
		return false
	}
	return c.conn.WriteMessage(kind, msg) == nil
}

// watchHub 按用户维护订阅集合。所有操作都在锁内遍历，保证 notify 与 remove 不竞态。
type watchHub struct {
	mu    sync.Mutex
	users map[string]map[*watchClient]struct{}
}

func newWatchHub() *watchHub {
	return &watchHub{users: make(map[string]map[*watchClient]struct{})}
}

func (h *watchHub) add(c *watchClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[c.userID] == nil {
		h.users[c.userID] = make(map[*watchClient]struct{})
	}
	h.users[c.userID][c] = struct{}{}
}

func (h *watchHub) remove(c *watchClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients := h.users[c.userID]
	delete(clients, c)
	if len(clients) == 0 {
		delete(h.users, c.userID)
	}
}

func (h *watchHub) each(fn func(*watchClient)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, clients := range h.users {
		for c := range clients {
			fn(c)
		}
	}
}

// notify 只发给同一账号的连接，并跳过发起本次写入的连接（from 非空时）。
// 缓冲已满说明客户端严重滞后，直接断开：它重连时会收到 ready 并补做一次同步，不会丢数据。
func (h *watchHub) notify(userID string, rev int64, from string) {
	msg := watchChangedMessage(rev)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[userID] {
		if from != "" && c.clientID == from {
			continue
		}
		if !c.enqueue(msg) {
			go c.shutdown()
		}
	}
}

// disconnectToken 精确断开使用某个 token 的连接，避免一个设备登出踢掉其它设备。
func (h *watchHub) disconnectToken(tokenHash string) {
	h.each(func(c *watchClient) {
		if c.tokenHash == tokenHash {
			c.shutdown()
		}
	})
}

// closeAll 用于进程退出：http.Server.Shutdown 不会关闭已被 Hijack 的 WebSocket 连接。
func (h *watchHub) closeAll() {
	h.each(func(c *watchClient) { c.shutdown() })
}

func (h *watchHub) count(userID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.users[userID])
}

func (c *watchClient) writeLoop(started time.Time) {
	ticker := time.NewTicker(watchPingInterval)
	defer ticker.Stop()
	defer c.shutdown()
	for {
		select {
		case <-c.done:
			return
		case msg := <-c.send:
			if !c.write(websocket.TextMessage, msg) {
				return
			}
		case <-ticker.C:
			if time.Since(started) >= watchMaxLifetime {
				return
			}
			if !c.write(websocket.TextMessage, watchPingMsg) {
				return
			}
		}
	}
}

// watchCheckOrigin 与 REST 的 CORS 白名单保持一致。WebSocket 没有预检请求，
// 因此必须在握手阶段自己拒绝未知来源；鉴权仍完全依赖首帧 token，不使用 cookie，
// 所以 file:// 页面（Origin: null）与非浏览器客户端（无 Origin）可以放行。
func watchCheckOrigin(allowed []string) func(*http.Request) bool {
	allowAll := allowAllOrigins(allowed)
	set := make(map[string]bool, len(allowed))
	for _, origin := range allowed {
		set[normalizeOrigin(origin)] = true
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" || origin == "null" {
			return true
		}
		if allowAll {
			return true
		}
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" {
			return false
		}
		if strings.EqualFold(parsed.Host, r.Host) {
			return true
		}
		return set[normalizeOrigin(origin)]
	}
}

// handleWatch 是 GET /api/watch 的 WebSocket 入口。浏览器 WebSocket API 不能自定义
// Authorization 头，也不宜把 token 放进 URL（会留在代理日志里），因此采用首帧认证：
// 连接建立后客户端立刻发送 {"type":"auth","token":"..."}，服务端校验通过才订阅。
func (s *Server) handleWatch(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     watchCheckOrigin(s.config.AllowedOrigins),
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade 失败时 Upgrader 已写好 HTTP 错误响应。
		return
	}
	if watchConnections.Add(1) > watchMaxConnections {
		watchConnections.Add(-1)
		_ = conn.Close()
		return
	}
	defer watchConnections.Add(-1)
	client := &watchClient{
		conn: conn,
		send: make(chan []byte, watchSendBuffer),
		done: make(chan struct{}),
	}
	defer client.shutdown()

	conn.SetReadLimit(watchMessageLimit)
	if err := conn.SetReadDeadline(time.Now().Add(watchAuthTimeout)); err != nil {
		return
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var first watchMessage
	if json.Unmarshal(data, &first) != nil || first.Type != "auth" || first.Token == "" {
		_ = client.write(websocket.TextMessage, watchAuthRequiredMsg)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), watchAuthTimeout)
	defer cancel()
	userID, err := s.auth.resolve(ctx, first.Token)
	if err != nil {
		msg := watchAuthRequiredMsg
		if err != errUnauthorized {
			// 数据库故障不是凭据问题，客户端应稍后重连而不是清除登录态。
			msg = watchServerErrorMsg
			slog.Warn("watch authentication failed", "error", err)
		}
		_ = client.write(websocket.TextMessage, msg)
		return
	}
	rev, err := currentRev(ctx, s.db, userID)
	if err != nil {
		slog.Warn("watch read current rev", "error", err)
		_ = client.write(websocket.TextMessage, watchServerErrorMsg)
		return
	}

	client.userID = userID
	client.tokenHash = hashToken(first.Token)
	// 客户端标识只用于跳过自身回环广播；缺失或非法时按「未知」处理，照常接收通知。
	client.clientID = normalizeClientID(first.ClientID)
	s.hub.add(client)
	defer s.hub.remove(client)

	started := time.Now()
	// ready 携带当前游标；客户端据此补一次同步，覆盖连接建立前发生的变更。
	client.enqueue(watchReadyMessage(rev))
	go client.writeLoop(started)

	if err := conn.SetReadDeadline(time.Now().Add(watchReadTimeout)); err != nil {
		return
	}
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			return
		}
		// 任何客户端消息都说明连接仍然存活；服务端靠 ping/pong 检测半开连接。
		if err := conn.SetReadDeadline(time.Now().Add(watchReadTimeout)); err != nil {
			return
		}
	}
}
