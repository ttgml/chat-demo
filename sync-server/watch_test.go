package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testClient(userID, tokenHash string) *watchClient {
	return &watchClient{
		userID:    userID,
		tokenHash: tokenHash,
		send:      make(chan []byte, watchSendBuffer),
		done:      make(chan struct{}),
	}
}

func readWatchMessage(t *testing.T, c *watchClient) watchMessage {
	t.Helper()
	select {
	case data := <-c.send:
		var msg watchMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("decode %q: %v", data, err)
		}
		return msg
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for watch message")
		return watchMessage{}
	}
}

func TestWatchHubIsolation(t *testing.T) {
	hub := newWatchHub()
	alice := testClient("alice", "hash-a")
	bob := testClient("bob", "hash-b")
	hub.add(alice)
	hub.add(bob)

	if hub.count("alice") != 1 || hub.count("bob") != 1 {
		t.Fatalf("unexpected subscriber counts: %d / %d", hub.count("alice"), hub.count("bob"))
	}

	hub.notify("alice", 7, "")
	msg := readWatchMessage(t, alice)
	if msg.Type != "changed" || msg.Rev != 7 {
		t.Fatalf("alice got %+v", msg)
	}
	select {
	case data := <-bob.send:
		t.Fatalf("bob must not receive alice's change, got %s", data)
	default:
	}

	hub.remove(bob)
	if hub.count("bob") != 0 {
		t.Fatal("bob should have no subscribers after remove")
	}
	hub.notify("bob", 8, "") // 空集合不应 panic

	hub.disconnectToken("hash-a")
	select {
	case <-alice.done:
	default:
		t.Fatal("disconnectToken did not shut down matching client")
	}
	select {
	case <-bob.done:
		t.Fatal("disconnectToken must not touch other tokens")
	default:
	}

	other := testClient("carol", "hash-c")
	hub.add(other)
	hub.closeAll()
	select {
	case <-other.done:
	default:
		t.Fatal("closeAll did not shut down client")
	}
}

func TestWatchReadyAlwaysHasRev(t *testing.T) {
	// 新账号的游标是 0，ready 也不能省略 rev 字段。
	for _, data := range [][]byte{watchReadyMessage(0), watchChangedMessage(0)} {
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		if _, ok := raw["rev"]; !ok {
			t.Fatalf("rev missing at zero: %s", data)
		}
	}
}

func TestWatchOrigin(t *testing.T) {
	check := watchCheckOrigin([]string{"http://localhost:8090/", "https://app.example.com"})
	cases := []struct {
		name, origin, host string
		want               bool
	}{
		{"same origin", "http://localhost:8080", "localhost:8080", true},
		{"allowlisted", "http://localhost:8090", "sync.example.com", true},
		{"allowlisted https", "https://app.example.com", "sync.example.com", true},
		{"unknown origin", "https://evil.example.com", "sync.example.com", false},
		{"origin mismatch", "http://localhost:8090.evil.com", "sync.example.com", false},
		{"no origin", "", "sync.example.com", true},
		{"file page", "null", "sync.example.com", true},
		{"malformed", "::not-a-url::", "sync.example.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := &http.Request{Host: tc.host, Header: http.Header{}}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := check(req); got != tc.want {
				t.Fatalf("origin %q host %q: got %v want %v", tc.origin, tc.host, got, tc.want)
			}
		})
	}
}

// dialWatch 建立并认证一条订阅连接，返回 ready 消息。
func dialWatch(t *testing.T, baseURL, token string) (*websocket.Conn, watchMessage) {
	t.Helper()
	return dialWatchWithClientID(t, baseURL, token, "")
}

// dialWatchWithClientID 额外上报客户端标识，模拟新版前端页面实例。
func dialWatchWithClientID(
	t *testing.T, baseURL, token, clientID string,
) (*websocket.Conn, watchMessage) {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(baseURL, "http")+"/api/watch", nil)
	if err != nil {
		t.Fatalf("dial watch: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.WriteJSON(watchMessage{Type: "auth", Token: token, ClientID: clientID}); err != nil {
		t.Fatalf("send auth: %v", err)
	}
	msg := readJSONWatch(t, conn, 3*time.Second)
	if msg.Type != "ready" && msg.Type != "auth_required" && msg.Type != "error" {
		t.Fatalf("unexpected first message: %+v", msg)
	}
	return conn, msg
}

func readJSONWatch(t *testing.T, conn *websocket.Conn, timeout time.Duration) watchMessage {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read watch message: %v", err)
	}
	var msg watchMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("decode %q: %v", data, err)
	}
	return msg
}

func TestWatchChangeNotification(t *testing.T) {
	ts, baseURL := testServer(t)
	alice := registerUser(t, ts, "watchalice")
	bob := registerUser(t, ts, "watchbob")

	aliceConn, ready := dialWatch(t, baseURL, alice)
	if ready.Type != "ready" {
		t.Fatalf("expected ready, got %+v", ready)
	}
	// 同一账号的第二个客户端也应收到通知。
	aliceConn2, ready2 := dialWatch(t, baseURL, alice)
	if ready2.Type != "ready" {
		t.Fatalf("expected ready for second client, got %+v", ready2)
	}
	bobConn, bobReady := dialWatch(t, baseURL, bob)
	if bobReady.Type != "ready" {
		t.Fatalf("expected ready for bob, got %+v", bobReady)
	}

	var put struct {
		Rev int64 `json:"rev"`
	}
	status := doJSON(t, ts, "PUT", "/api/session/watch-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": map[string]any{"id": "watch-1"},
	}, &put)
	if status != 200 {
		t.Fatalf("put session status=%d", status)
	}

	for _, conn := range []*websocket.Conn{aliceConn, aliceConn2} {
		msg := readJSONWatch(t, conn, 3*time.Second)
		if msg.Type != "changed" || msg.Rev != put.Rev {
			t.Fatalf("expected changed rev=%d, got %+v", put.Rev, msg)
		}
	}

	// 用户隔离：bob 不应收到 alice 的变更。
	if err := bobConn.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := bobConn.ReadMessage(); err == nil {
		t.Fatal("bob received alice's change")
	} else if netErr, ok := err.(interface{ Timeout() bool }); !ok || !netErr.Timeout() {
		t.Fatalf("expected read timeout for bob, got %v", err)
	}

	// 无效 token 收到 auth_required，不会挂住连接。
	badConn, bad := dialWatch(t, baseURL, "not-a-real-token")
	if bad.Type != "auth_required" {
		t.Fatalf("expected auth_required, got %+v", bad)
	}
	_ = badConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := badConn.ReadMessage(); err == nil {
		t.Fatal("unauthenticated watch should be closed")
	}
}

func TestWatchLogoutDisconnectsToken(t *testing.T) {
	ts, baseURL := testServer(t)
	alice := registerUser(t, ts, "logoutwatch")
	conn, ready := dialWatch(t, baseURL, alice)
	if ready.Type != "ready" {
		t.Fatalf("expected ready, got %+v", ready)
	}

	status := doJSON(t, ts, "POST", "/api/logout", alice, nil, nil)
	if status != 200 {
		t.Fatalf("logout status=%d", status)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("watch connection should close after logout")
	}
}

func TestWatchOriginWildcard(t *testing.T) {
	check := watchCheckOrigin([]string{"*"})
	for _, tc := range []struct {
		name, origin, host string
		want               bool
	}{
		{"any origin", "https://any.example.com", "sync.example.com", true},
		{"localhost", "http://localhost:8090", "sync.example.com", true},
		{"null", "null", "sync.example.com", true},
		{"no origin", "", "sync.example.com", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := &http.Request{Host: tc.host, Header: http.Header{}}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := check(req); got != tc.want {
				t.Fatalf("origin %q: got %v want %v", tc.origin, got, tc.want)
			}
		})
	}
}

func TestWatchHubSkipsWritingClient(t *testing.T) {
	hub := newWatchHub()
	origin := testClient("alice", "hash-a")
	origin.clientID = "tab-a"
	other := testClient("alice", "hash-b")
	other.clientID = "tab-b"
	hub.add(origin)
	hub.add(other)

	// 写入方自己不该收到回环通知，同账号的其它连接照常收到。
	hub.notify("alice", 9, "tab-a")
	msg := readWatchMessage(t, other)
	if msg.Type != "changed" || msg.Rev != 9 {
		t.Fatalf("other tab got %+v", msg)
	}
	select {
	case data := <-origin.send:
		t.Fatalf("writing client must not receive its own change, got %s", data)
	default:
	}

	// 未知来源（空 from）时广播给所有连接，兼容未升级的客户端。
	hub.notify("alice", 10, "")
	for _, c := range []*watchClient{origin, other} {
		if msg := readWatchMessage(t, c); msg.Rev != 10 {
			t.Fatalf("client got %+v", msg)
		}
	}
}

func TestNormalizeClientID(t *testing.T) {
	cases := map[string]string{
		"tab-1":                 "tab-1",
		"  a_b.c-D  ":           "a_b.c-D",
		"":                      "",
		"bad id":                "",
		"x":                     "x",
		strings.Repeat("a", 65): "",
		strings.Repeat("a", 64): strings.Repeat("a", 64),
	}
	for input, want := range cases {
		if got := normalizeClientID(input); got != want {
			t.Fatalf("normalize %q: got %q want %q", input, got, want)
		}
	}
}

// expectNoWatchMessage 断言连接在短暂等待内收不到消息。
func expectNoWatchMessage(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("connection should not receive a message")
	} else if netErr, ok := err.(interface{ Timeout() bool }); !ok || !netErr.Timeout() {
		t.Fatalf("expected read timeout, got %v", err)
	}
}

// TestWatchSkipsOwnWrites 验证写入方不会收到自己写入产生的 changed 通知，
// 而同账号的其它页面/设备（不同 clientId）以及未上报 clientId 的旧客户端仍会收到。
func TestWatchSkipsOwnWrites(t *testing.T) {
	ts, baseURL := testServer(t)
	alice := registerUser(t, ts, "watchself")

	writer, ready := dialWatchWithClientID(t, baseURL, alice, "tab-a")
	if ready.Type != "ready" {
		t.Fatalf("expected ready, got %+v", ready)
	}
	other, otherReady := dialWatchWithClientID(t, baseURL, alice, "tab-b")
	if otherReady.Type != "ready" {
		t.Fatalf("expected ready for other tab, got %+v", otherReady)
	}
	legacy, legacyReady := dialWatch(t, baseURL, alice)
	if legacyReady.Type != "ready" {
		t.Fatalf("expected ready for legacy client, got %+v", legacyReady)
	}

	var put struct {
		Rev int64 `json:"rev"`
	}
	status := doJSONWithClientID(t, ts, "PUT", "/api/session/watch-self-1", alice, "tab-a", map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": map[string]any{"id": "watch-self-1"},
	}, &put)
	if status != 200 {
		t.Fatalf("put session status=%d", status)
	}
	for _, conn := range []*websocket.Conn{other, legacy} {
		msg := readJSONWatch(t, conn, 3*time.Second)
		if msg.Type != "changed" || msg.Rev != put.Rev {
			t.Fatalf("expected changed rev=%d, got %+v", put.Rev, msg)
		}
	}
	firstRev := put.Rev

	// 另一个页面写入时，本页面应当收到通知；若收到的是上一批自己的回环，
	// 这里的 rev 会对不上（读超时会让连接不可复用，所以「收不到」放到最后断言）。
	status = doJSONWithClientID(t, ts, "PUT", "/api/session/watch-self-2", alice, "tab-b", map[string]any{
		"baseRev": 0, "updatedAt": 1001, "session": map[string]any{"id": "watch-self-2"},
	}, &put)
	if status != 200 {
		t.Fatalf("put session status=%d", status)
	}
	if put.Rev == firstRev {
		t.Fatalf("expected a new rev, got %d", put.Rev)
	}
	msg := readJSONWatch(t, writer, 3*time.Second)
	if msg.Type != "changed" || msg.Rev != put.Rev {
		t.Fatalf("expected changed rev=%d, got %+v", put.Rev, msg)
	}
	// 写入方不应再有第二条积压消息（也就是自己那次写入的回环）。
	expectNoWatchMessage(t, writer)
}
