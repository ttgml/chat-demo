package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 每次 go test 生成不同后缀，避免复用同一个 Postgres 时用户名冲突，
// 也避免测试去 TRUNCATE 用户可能正在使用的库。
var testRunID = func() string {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(buf)
}()

func uniqueName(base string) string { return base + "_" + testRunID }

// 集成测试需要真实 Postgres：SYNC_TEST_DATABASE_URL=postgres://... go test ./...
// 未设置时自动跳过，便于纯单元测试环境运行。
func testServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	url := os.Getenv("SYNC_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("SYNC_TEST_DATABASE_URL not set, skipping integration test")
	}
	ctx := context.Background()
	db, err := openDB(ctx, url)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(db.Close)

	// 每个测试用随机前缀隔离数据。
	cfg := Config{
		TokenTTL:        24 * time.Hour,
		MaxSessionBytes: 8 << 20,
		MaxFileBytes:    32 << 20,
		LoginLimit:      100,
		LoginWindow:     time.Minute,
	}
	auth := newAuthService(db, cfg.TokenTTL, cfg.LoginLimit, cfg.LoginWindow)
	srv := &Server{db: db, auth: auth, config: cfg}
	ts := httptest.NewServer(routes(srv, cfg))
	t.Cleanup(ts.Close)
	return ts, ts.URL
}

func doJSON(t *testing.T, ts *httptest.Server, method, path, token string, body any, target any) int {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if target != nil && len(data) > 0 {
		if err := json.Unmarshal(data, target); err != nil {
			t.Fatalf("decode %s: %v (%s)", path, err, data)
		}
	}
	return resp.StatusCode
}

func registerUser(t *testing.T, ts *httptest.Server, username string) string {
	t.Helper()
	var result struct {
		Token string `json:"token"`
	}
	status := doJSON(t, ts, "POST", "/api/register", "", map[string]string{
		"username": uniqueName(username), "password": "password123",
	}, &result)
	if status != 201 || result.Token == "" {
		t.Fatalf("register status=%d token=%q", status, result.Token)
	}
	return result.Token
}

func TestSyncRoundTrip(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "alice")
	bob := registerUser(t, ts, "bob")

	// 会话原始 JSON：服务端不应解析内部字段，包含一个特殊字段验证无损。
	session := map[string]any{
		"id": "session-1", "title": "测试会话", "updatedAt": 1000,
		"customField": map[string]any{"keep": true},
	}
	var put struct {
		Rev int64 `json:"rev"`
	}
	status := doJSON(t, ts, "PUT", "/api/session/session-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": session,
	}, &put)
	if status != 200 || put.Rev <= 0 {
		t.Fatalf("put session status=%d rev=%d", status, put.Rev)
	}

	// /api/state 同时返回游标与云端会话数，计数按账号隔离。
	type stateResponse struct {
		Rev      int64 `json:"rev"`
		Sessions int64 `json:"sessions"`
	}
	var aliceState stateResponse
	doJSON(t, ts, "GET", "/api/state", alice, nil, &aliceState)
	if aliceState.Rev != put.Rev || aliceState.Sessions != 1 {
		t.Fatalf("alice state = %+v, want rev=%d sessions=1", aliceState, put.Rev)
	}
	var bobState stateResponse
	doJSON(t, ts, "GET", "/api/state", bob, nil, &bobState)
	if bobState.Sessions != 0 {
		t.Fatalf("bob state = %+v, want sessions=0", bobState)
	}

	// 拉取变更：alice 能看到，bob 看不到（用户隔离）。
	var aliceChanges changesResponse
	doJSON(t, ts, "GET", "/api/changes?since=0", alice, nil, &aliceChanges)
	if len(aliceChanges.Sessions) != 1 || aliceChanges.Sessions[0].ID != "session-1" {
		t.Fatalf("alice changes = %+v", aliceChanges)
	}
	var bobChanges changesResponse
	doJSON(t, ts, "GET", "/api/changes?since=0", bob, nil, &bobChanges)
	if len(bobChanges.Sessions) != 0 || len(bobChanges.Files) != 0 {
		t.Fatalf("bob should see no changes, got %+v", bobChanges)
	}

	// 下载会话，确认原始字段无损保留。
	var got struct {
		Rev       int64          `json:"rev"`
		UpdatedAt int64          `json:"updatedAt"`
		Session   map[string]any `json:"session"`
	}
	doJSON(t, ts, "GET", "/api/session/session-1", alice, nil, &got)
	if got.Session["customField"] == nil || got.Session["title"] != "测试会话" {
		t.Fatalf("session not lossless: %+v", got.Session)
	}

	// 用过期 baseRev 上传应返回 409。
	var conflict struct {
		Error     string `json:"error"`
		ServerRev int64  `json:"serverRev"`
	}
	status = doJSON(t, ts, "PUT", "/api/session/session-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 2000, "session": session,
	}, &conflict)
	if status != 409 || conflict.Error != "conflict" {
		t.Fatalf("expected conflict, status=%d body=%+v", status, conflict)
	}

	// 用正确 baseRev 更新成功。
	status = doJSON(t, ts, "PUT", "/api/session/session-1", alice, map[string]any{
		"baseRev": put.Rev, "updatedAt": 2000, "session": session,
	}, &put)
	if status != 200 {
		t.Fatalf("update with correct baseRev status=%d", status)
	}

	// 删除墓碑：变更列表里应标记 deleted。
	doJSON(t, ts, "DELETE", "/api/session/session-1?baseRev="+strconv.FormatInt(put.Rev, 10), alice, nil, &put)
	var afterDelete changesResponse
	doJSON(t, ts, "GET", "/api/changes?since=0", alice, nil, &afterDelete)
	found := false
	for _, c := range afterDelete.Sessions {
		if c.ID == "session-1" && c.Deleted {
			found = true
		}
	}
	if !found {
		t.Fatalf("delete tombstone missing: %+v", afterDelete.Sessions)
	}
	// 墓碑仍出现在变更列表里，但不计入 /api/state 的会话数。
	var afterDeleteState stateResponse
	doJSON(t, ts, "GET", "/api/state", alice, nil, &afterDeleteState)
	if afterDeleteState.Sessions != 0 {
		t.Fatalf("state after delete = %+v, want sessions=0", afterDeleteState)
	}
}

func TestFileRoundTrip(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "fileuser")

	payload := []byte("fake-image-bytes-12345")
	req, _ := http.NewRequest("PUT", ts.URL+"/api/file/file-1", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+alice)
	req.Header.Set("Content-Type", "image/png")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("put file status=%d", resp.StatusCode)
	}

	req, _ = http.NewRequest("GET", ts.URL+"/api/file/file-1", nil)
	req.Header.Set("Authorization", "Bearer "+alice)
	resp, err = ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, payload) {
		t.Fatalf("file bytes mismatch: got %q", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}

	// 无 token 访问应 401。
	resp2, err := ts.Client().Get(ts.URL + "/api/file/file-1")
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 401 {
		t.Fatalf("unauthorized status = %d", resp2.StatusCode)
	}
}

// 回归测试：分页时 nextSince 必须是本页最大 rev，不能用全局 head，
// 否则中间未返回的变更会被跳过，导致数据静默丢失。
func TestChangesPaginationCursor(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "pageuser")
	session := map[string]any{"id": "s", "title": "t", "updatedAt": 1}

	// 交替写入 4 个会话和 3 个附件，制造交错的不同 rev。
	for i, name := range []string{"s1", "s2", "s3", "s4"} {
		var put struct {
			Rev int64 `json:"rev"`
		}
		status := doJSON(t, ts, "PUT", "/api/session/"+name, alice, map[string]any{
			"baseRev": 0, "updatedAt": int64(i), "session": session,
		}, &put)
		if status != 200 {
			t.Fatalf("put %s status=%d", name, status)
		}
		if i < 3 {
			req, _ := http.NewRequest("PUT", ts.URL+"/api/file/f"+strconv.Itoa(i+1), bytes.NewReader([]byte("x")))
			req.Header.Set("Authorization", "Bearer "+alice)
			req.Header.Set("Content-Type", "image/png")
			resp, err := ts.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("put file status=%d", resp.StatusCode)
			}
		}
	}

	// 用小 limit 逐页遍历，收集全部变更，验证一页不漏。
	var seen []string
	since := int64(0)
	for page := 0; page < 20; page++ {
		var result struct {
			Sessions  []change `json:"sessions"`
			Files     []change `json:"files"`
			HasMore   bool     `json:"hasMore"`
			NextSince int64    `json:"nextSince"`
			Rev       int64    `json:"rev"`
		}
		status := doJSON(t, ts, "GET", "/api/changes?since="+strconv.FormatInt(since, 10)+"&limit=2", alice, nil, &result)
		if status != 200 {
			t.Fatalf("changes status=%d", status)
		}
		for _, c := range result.Sessions {
			seen = append(seen, "s:"+c.ID)
		}
		for _, c := range result.Files {
			seen = append(seen, "f:"+c.ID)
		}
		if result.NextSince <= since && result.HasMore {
			t.Fatalf("nextSince did not advance: since=%d nextSince=%d", since, result.NextSince)
		}
		since = result.NextSince
		if !result.HasMore {
			break
		}
	}
	if len(seen) != 7 {
		t.Fatalf("expected 7 changes total, got %d: %v", len(seen), seen)
	}
	// 会话和附件都应出现，确认两类变更没有被对方的游标挤掉。
	var gotS, gotF int
	for _, item := range seen {
		if strings.HasPrefix(item, "s:") {
			gotS++
		}
		if strings.HasPrefix(item, "f:") {
			gotF++
		}
	}
	if gotS != 4 || gotF != 3 {
		t.Fatalf("expected 4 sessions and 3 files, got %d and %d: %v", gotS, gotF, seen)
	}
}

func TestAuthFlow(t *testing.T) {
	ts, _ := testServer(t)
	username := uniqueName("authuser")
	registerUser(t, ts, "authuser")

	var result struct {
		Token string `json:"token"`
	}
	status := doJSON(t, ts, "POST", "/api/login", "", map[string]string{
		"username": username, "password": "password123",
	}, &result)
	if status != 200 || result.Token == "" {
		t.Fatalf("login status=%d token=%q", status, result.Token)
	}

	status = doJSON(t, ts, "POST", "/api/login", "", map[string]string{
		"username": username, "password": "wrongpassword",
	}, &result)
	if status != 401 {
		t.Fatalf("wrong password status=%d", status)
	}

	// 重复注册同一用户名应 409。
	status = doJSON(t, ts, "POST", "/api/register", "", map[string]string{
		"username": username, "password": "password123",
	}, &result)
	if status != 409 {
		t.Fatalf("duplicate register status=%d", status)
	}
}
