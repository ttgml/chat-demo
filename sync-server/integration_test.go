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
	return testServerWithConfig(t, func(*Config) {})
}

// testServerWithConfig 允许单个测试收紧配置（例如更小的会话体积上限），
// 避免为了验证限额而构造几十 MB 的请求。
func testServerWithConfig(t *testing.T, mutate func(*Config)) (*httptest.Server, string) {
	t.Helper()
	url := os.Getenv("SYNC_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("SYNC_TEST_DATABASE_URL not set, skipping integration test")
	}
	ctx := context.Background()
	db, err := openDB(ctx, url, poolOptions{})
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
	mutate(&cfg)
	auth := newAuthService(db, cfg.TokenTTL, cfg.LoginLimit, cfg.LoginWindow)
	srv := &Server{db: db, auth: auth, config: cfg}
	ts := httptest.NewServer(routes(srv, cfg))
	t.Cleanup(ts.Close)
	return ts, ts.URL
}

func doJSON(t *testing.T, ts *httptest.Server, method, path, token string, body any, target any) int {
	t.Helper()
	return doJSONWithClientID(t, ts, method, path, token, "", body, target)
}

// doJSONWithClientID 额外带上客户端标识，用于验证服务端不会把变更推回写入方自己。
func doJSONWithClientID(
	t *testing.T, ts *httptest.Server, method, path, token, clientID string, body any, target any,
) int {
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
	if clientID != "" {
		req.Header.Set(clientIDHeader, clientID)
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

// 回归测试：重新导入备份属于显式全量替换，需要能覆盖云端墓碑恢复会话。
// 但普通编辑（不带 revive）即使 baseRev 匹配也不能把已删除会话「复活」，
// 且 revive 不能绕过 baseRev 乐观锁。
func TestReviveDeletedSession(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "reviveuser")
	session := map[string]any{
		"id": "revive-1", "title": "导入的会话", "createdAt": 900,
		"updatedAt": 1000, "messages": []any{},
	}
	var put struct {
		Rev int64 `json:"rev"`
	}
	status := doJSON(t, ts, "PUT", "/api/session/revive-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": session,
	}, &put)
	if status != 200 || put.Rev <= 0 {
		t.Fatalf("put session status=%d rev=%d", status, put.Rev)
	}

	var tombstone struct {
		Rev int64 `json:"rev"`
	}
	status = doJSON(t, ts, "DELETE", "/api/session/revive-1?baseRev="+strconv.FormatInt(put.Rev, 10),
		alice, nil, &tombstone)
	if status != 200 || tombstone.Rev <= put.Rev {
		t.Fatalf("delete status=%d rev=%d, after put rev=%d", status, tombstone.Rev, put.Rev)
	}

	var conflict struct {
		Error     string `json:"error"`
		Deleted   bool   `json:"deleted"`
		ServerRev int64  `json:"serverRev"`
	}
	status = doJSON(t, ts, "PUT", "/api/session/revive-1", alice, map[string]any{
		"baseRev": tombstone.Rev, "updatedAt": 1000, "session": session,
	}, &conflict)
	if status != 409 || conflict.Error != "conflict" || !conflict.Deleted || conflict.ServerRev != tombstone.Rev {
		t.Fatalf("plain put over tombstone status=%d body=%+v", status, conflict)
	}

	// revive 但 baseRev 过期：仍必须 409，防止跳过乐观锁覆盖其他设备的写入。
	status = doJSON(t, ts, "PUT", "/api/session/revive-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": session, "revive": true,
	}, &conflict)
	if status != 409 || conflict.ServerRev != tombstone.Rev {
		t.Fatalf("revive with stale baseRev status=%d body=%+v", status, conflict)
	}

	status = doJSON(t, ts, "PUT", "/api/session/revive-1", alice, map[string]any{
		"baseRev": tombstone.Rev, "updatedAt": 1000, "session": session, "revive": true,
	}, &put)
	if status != 200 || put.Rev <= tombstone.Rev {
		t.Fatalf("revive status=%d rev=%d, tombstone rev=%d", status, put.Rev, tombstone.Rev)
	}

	var got struct {
		Deleted bool           `json:"deleted"`
		Session map[string]any `json:"session"`
	}
	doJSON(t, ts, "GET", "/api/session/revive-1", alice, nil, &got)
	if got.Deleted || got.Session["title"] != "导入的会话" {
		t.Fatalf("revived session = %+v", got)
	}

	var state struct {
		Sessions int64 `json:"sessions"`
	}
	doJSON(t, ts, "GET", "/api/state", alice, nil, &state)
	if state.Sessions != 1 {
		t.Fatalf("state after revive = %+v, want sessions=1", state)
	}
	var changes changesResponse
	doJSON(t, ts, "GET", "/api/changes?since=0", alice, nil, &changes)
	if len(changes.Sessions) != 1 || changes.Sessions[0].Deleted {
		t.Fatalf("changes after revive = %+v", changes.Sessions)
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

// 回归测试：服务端曾先检查 baseRev、再递增 user_rev，两个并发 PUT 会同时通过检查，
// 后提交者静默覆盖先提交者且双方都收到 200。现在先拿 user_rev 行锁，必须恰好一个 200、一个 409。
func TestConcurrentPutRespectsBaseRev(t *testing.T) {
	ts, _ := testServer(t)
	token := registerUser(t, ts, "raceuser")
	makeSession := func(title string) map[string]any {
		return map[string]any{
			"id": "race-1", "title": title, "createdAt": 1000, "updatedAt": 1000,
			"messages": []any{},
		}
	}
	var created struct {
		Rev int64 `json:"rev"`
	}
	status := doJSON(t, ts, "PUT", "/api/session/race-1", token, map[string]any{
		"baseRev": 0, "updatedAt": 1000, "session": makeSession("initial"),
	}, &created)
	if status != 200 || created.Rev <= 0 {
		t.Fatalf("create status=%d rev=%d", status, created.Rev)
	}

	type result struct {
		status int
		title  string
		err    error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, title := range []string{"device-a", "device-b"} {
		title := title
		go func() {
			<-start
			body, err := json.Marshal(map[string]any{
				"baseRev": created.Rev, "updatedAt": 2000, "session": makeSession(title),
			})
			if err != nil {
				results <- result{err: err}
				return
			}
			req, err := http.NewRequest("PUT", ts.URL+"/api/session/race-1", bytes.NewReader(body))
			if err != nil {
				results <- result{err: err}
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := ts.Client().Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			results <- result{status: resp.StatusCode, title: title}
		}()
	}
	close(start)

	var ok, conflict int
	winner := ""
	for i := 0; i < 2; i++ {
		res := <-results
		if res.err != nil {
			t.Fatalf("concurrent put failed: %v", res.err)
		}
		switch res.status {
		case http.StatusOK:
			ok++
			winner = res.title
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("unexpected status %d", res.status)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("want exactly one 200 and one 409, got ok=%d conflict=%d", ok, conflict)
	}

	var got struct {
		Session map[string]any `json:"session"`
	}
	doJSON(t, ts, "GET", "/api/session/race-1", token, nil, &got)
	if got.Session["title"] != winner {
		t.Fatalf("stored title = %v, want winner %q", got.Session["title"], winner)
	}
}

// 回归测试：SYNC_MAX_SESSION_BYTES 之前只参与全局 body 上限计算，handler 内没有精确检查，
// 会话实际可以膨胀到 MaxFileBytes 的大小。
func TestPutSessionRespectsMaxSessionBytes(t *testing.T) {
	ts, _ := testServerWithConfig(t, func(cfg *Config) {
		cfg.MaxSessionBytes = 1024
		cfg.MaxFileBytes = 1 << 20
	})
	token := registerUser(t, ts, "sizeuser")

	tooLarge := map[string]any{
		"id": "big", "title": strings.Repeat("x", 2048), "createdAt": 1,
		"updatedAt": 1, "messages": []any{},
	}
	status := doJSON(t, ts, "PUT", "/api/session/big", token, map[string]any{
		"baseRev": 0, "updatedAt": 1, "session": tooLarge,
	}, nil)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized session status=%d, want 413", status)
	}

	small := map[string]any{
		"id": "small", "title": "ok", "createdAt": 1,
		"updatedAt": 1, "messages": []any{},
	}
	status = doJSON(t, ts, "PUT", "/api/session/small", token, map[string]any{
		"baseRev": 0, "updatedAt": 1, "session": small,
	}, nil)
	if status != http.StatusOK {
		t.Fatalf("session under limit status=%d, want 200", status)
	}
}

// 批量拉取是分页同步的主路径：一页最多 200 条变更，逐条 GET 会放大成数百次请求。
func TestBatchSessions(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "batchalice")
	bob := registerUser(t, ts, "batchbob")

	putSession := func(token, id string) int64 {
		var result struct {
			Rev int64 `json:"rev"`
		}
		status := doJSON(t, ts, "PUT", "/api/session/"+id, token, map[string]any{
			"baseRev": 0, "updatedAt": 10,
			"session": map[string]any{"id": id, "title": id, "createdAt": 1, "updatedAt": 10, "messages": []any{}},
		}, &result)
		if status != http.StatusOK {
			t.Fatalf("put %s status=%d", id, status)
		}
		return result.Rev
	}
	revA := putSession(alice, "batch-a")
	revB := putSession(alice, "batch-b")
	// 删除 batch-b，批量接口必须同样返回墓碑。
	if status := doJSON(t, ts, "DELETE", "/api/session/batch-b?baseRev="+strconv.FormatInt(revB, 10), alice, nil, nil); status != http.StatusOK {
		t.Fatalf("delete status=%d", status)
	}

	var batch batchSessionsResponse
	status := doJSON(t, ts, "POST", "/api/sessions/batch", alice, map[string]any{
		"ids": []string{"batch-a", "batch-b", "never-existed"},
	}, &batch)
	if status != http.StatusOK {
		t.Fatalf("batch status=%d", status)
	}
	if batch.Truncated {
		t.Fatalf("unexpected truncation: %+v", batch)
	}
	// 按请求顺序返回，且不存在的 id 直接不出现。
	if len(batch.Sessions) != 2 || batch.Sessions[0].ID != "batch-a" || batch.Sessions[1].ID != "batch-b" {
		t.Fatalf("batch sessions = %+v", batch.Sessions)
	}
	if batch.Sessions[0].Rev != revA || batch.Sessions[0].Deleted {
		t.Fatalf("live session = %+v", batch.Sessions[0])
	}
	if !json.Valid(batch.Sessions[0].Session) || !strings.Contains(string(batch.Sessions[0].Session), `"batch-a"`) {
		t.Fatalf("session payload = %s", batch.Sessions[0].Session)
	}
	if !batch.Sessions[1].Deleted {
		t.Fatalf("tombstone not reported: %+v", batch.Sessions[1])
	}

	// 用户隔离：bob 拿不到 alice 的会话。
	var bobBatch batchSessionsResponse
	doJSON(t, ts, "POST", "/api/sessions/batch", bob, map[string]any{"ids": []string{"batch-a"}}, &bobBatch)
	if len(bobBatch.Sessions) != 0 {
		t.Fatalf("bob sees alice sessions: %+v", bobBatch.Sessions)
	}

	// 参数校验：空列表、超量、非法 id、未登录。
	if status := doJSON(t, ts, "POST", "/api/sessions/batch", alice, map[string]any{"ids": []string{}}, nil); status != http.StatusBadRequest {
		t.Fatalf("empty ids status=%d, want 400", status)
	}
	tooMany := make([]string, maxBatchSessions+1)
	for index := range tooMany {
		tooMany[index] = "id-" + strconv.Itoa(index)
	}
	if status := doJSON(t, ts, "POST", "/api/sessions/batch", alice, map[string]any{"ids": tooMany}, nil); status != http.StatusBadRequest {
		t.Fatalf("too many ids status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "POST", "/api/sessions/batch", alice, map[string]any{"ids": []string{"../etc/passwd"}}, nil); status != http.StatusBadRequest {
		t.Fatalf("invalid id status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "POST", "/api/sessions/batch", "", map[string]any{"ids": []string{"batch-a"}}, nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d, want 401", status)
	}
}

// 批量上传是 push 阶段的主路径：导入上千条历史时逐条 PUT 会放大成上千次
// 鉴权查库 + 事务 + 广播。这里验证语义与单条接口一致（逐条乐观锁、墓碑保护），
// 且部分冲突不会让整批失败。
func TestBatchPutSessions(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "putbatchalice")
	bob := registerUser(t, ts, "putbatchbob")

	session := func(id, title string, updatedAt int64) map[string]any {
		return map[string]any{
			"id": id, "title": title, "createdAt": 1, "updatedAt": updatedAt, "messages": []any{},
		}
	}
	// 先用单条接口写一条，作为后续冲突的基准。
	var put struct {
		Rev int64 `json:"rev"`
	}
	if status := doJSON(t, ts, "PUT", "/api/session/bp-1", alice, map[string]any{
		"baseRev": 0, "updatedAt": 1, "session": session("bp-1", "v1", 1),
	}, &put); status != http.StatusOK {
		t.Fatalf("put baseline status=%d", status)
	}
	baselineRev := put.Rev

	var batch putSessionsResponse
	status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{
			// 新建
			map[string]any{"id": "bp-2", "baseRev": 0, "updatedAt": 2, "session": session("bp-2", "v1", 2)},
			// 过期 baseRev：单条冲突，但不能影响同批其它会话
			map[string]any{"id": "bp-1", "baseRev": 0, "updatedAt": 3, "session": session("bp-1", "stale", 3)},
			map[string]any{"id": "bp-3", "baseRev": 0, "updatedAt": 5, "session": session("bp-3", "v1", 5)},
		},
	}, &batch)
	if status != http.StatusOK {
		t.Fatalf("batch put status=%d", status)
	}
	if len(batch.Results) != 3 {
		t.Fatalf("results = %+v", batch.Results)
	}
	// 按请求顺序返回，且成功项的 rev 严格递增（同一批共享一次游标推进）。
	for index, result := range batch.Results {
		if result.ID != []string{"bp-2", "bp-1", "bp-3"}[index] {
			t.Fatalf("result %d out of order: %+v", index, result)
		}
	}
	if batch.Results[0].Conflict || batch.Results[0].Rev <= baselineRev {
		t.Fatalf("new session result = %+v", batch.Results[0])
	}
	if !batch.Results[1].Conflict || batch.Results[1].ServerRev != baselineRev || batch.Results[1].Deleted {
		t.Fatalf("stale session result = %+v", batch.Results[1])
	}
	if batch.Results[2].Conflict || batch.Results[2].Rev <= batch.Results[0].Rev {
		t.Fatalf("third result = %+v", batch.Results[2])
	}

	// 冲突项不能落库：bp-1 还是第一版。
	var got struct {
		Rev     int64          `json:"rev"`
		Session map[string]any `json:"session"`
	}
	doJSON(t, ts, "GET", "/api/session/bp-1", alice, nil, &got)
	if got.Session["title"] != "v1" || got.Rev != baselineRev {
		t.Fatalf("bp-1 = rev %d session %+v", got.Rev, got.Session)
	}

	// 整批只推进一次游标：state.rev 等于本批最大 rev。
	var state struct {
		Rev      int64 `json:"rev"`
		Sessions int64 `json:"sessions"`
	}
	doJSON(t, ts, "GET", "/api/state", alice, nil, &state)
	if state.Rev != batch.Results[2].Rev || state.Sessions != 3 {
		t.Fatalf("state = %+v, want rev=%d sessions=3", state, batch.Results[2].Rev)
	}

	// 带正确 baseRev 的更新在下一批里成功。
	var update putSessionsResponse
	doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{
			map[string]any{"id": "bp-1", "baseRev": baselineRev, "updatedAt": 4, "session": session("bp-1", "v2", 4)},
		},
	}, &update)
	if len(update.Results) != 1 || update.Results[0].Conflict {
		t.Fatalf("update result = %+v", update.Results)
	}
	doJSON(t, ts, "GET", "/api/session/bp-1", alice, nil, &got)
	if got.Session["title"] != "v2" || got.Rev != update.Results[0].Rev {
		t.Fatalf("bp-1 = rev %d session %+v", got.Rev, got.Session)
	}

	// 墓碑风控与单条接口一致：默认冲突、带 revive 才能恢复。
	if status := doJSON(t, ts, "DELETE", "/api/session/bp-3?baseRev="+strconv.FormatInt(batch.Results[2].Rev, 10), alice, nil, &put); status != http.StatusOK {
		t.Fatalf("delete status=%d", status)
	}
	tombstoneRev := put.Rev
	var refused putSessionsResponse
	doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{
			map[string]any{"id": "bp-3", "baseRev": tombstoneRev, "updatedAt": 6, "session": session("bp-3", "old", 6)},
		},
	}, &refused)
	if len(refused.Results) != 1 || !refused.Results[0].Conflict || !refused.Results[0].Deleted {
		t.Fatalf("tombstone without revive = %+v", refused.Results)
	}
	var revived putSessionsResponse
	doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{
			map[string]any{"id": "bp-3", "baseRev": tombstoneRev, "updatedAt": 7, "revive": true, "session": session("bp-3", "revived", 7)},
		},
	}, &revived)
	if len(revived.Results) != 1 || revived.Results[0].Conflict || revived.Results[0].Rev <= tombstoneRev {
		t.Fatalf("revive result = %+v", revived.Results)
	}

	// 用户隔离：bob 的同一个 id 是另一条记录，不会与 alice 的版本号冲突。
	var bobBatch putSessionsResponse
	doJSON(t, ts, "PUT", "/api/sessions/batch", bob, map[string]any{
		"sessions": []any{
			map[string]any{"id": "bp-1", "baseRev": 0, "updatedAt": 1, "session": session("bp-1", "bob", 1)},
		},
	}, &bobBatch)
	if len(bobBatch.Results) != 1 || bobBatch.Results[0].Conflict {
		t.Fatalf("bob batch = %+v", bobBatch.Results)
	}
	doJSON(t, ts, "GET", "/api/session/bp-1", alice, nil, &got)
	if got.Session["title"] != "v2" {
		t.Fatalf("alice session overwritten by bob: %+v", got.Session)
	}

	// 参数校验。
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{"sessions": []any{}}, nil); status != http.StatusBadRequest {
		t.Fatalf("empty batch status=%d, want 400", status)
	}
	tooMany := make([]any, maxPutBatchSessions+1)
	for index := range tooMany {
		id := "id-" + strconv.Itoa(index)
		tooMany[index] = map[string]any{"id": id, "baseRev": 0, "session": session(id, id, 1)}
	}
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{"sessions": tooMany}, nil); status != http.StatusBadRequest {
		t.Fatalf("oversized batch status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{
			map[string]any{"id": "dup", "baseRev": 0, "session": session("dup", "dup", 1)},
			map[string]any{"id": "dup", "baseRev": 0, "session": session("dup", "dup", 1)},
		},
	}, nil); status != http.StatusBadRequest {
		t.Fatalf("duplicate ids status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{map[string]any{"id": "../etc/passwd", "baseRev": 0, "session": session("x", "x", 1)}},
	}, nil); status != http.StatusBadRequest {
		t.Fatalf("invalid id status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", alice, map[string]any{
		"sessions": []any{map[string]any{"id": "bp-1", "baseRev": 0}},
	}, nil); status != http.StatusBadRequest {
		t.Fatalf("missing session status=%d, want 400", status)
	}
	if status := doJSON(t, ts, "PUT", "/api/sessions/batch", "", map[string]any{
		"sessions": []any{map[string]any{"id": "bp-1", "baseRev": 0, "session": session("bp-1", "x", 1)}},
	}, nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d, want 401", status)
	}
}

// 批量接口同样要遵守单条会话的体积上限，否则它可以绕过 SYNC_MAX_SESSION_BYTES。
func TestBatchPutSessionsRespectsMaxSessionBytes(t *testing.T) {
	ts, _ := testServerWithConfig(t, func(cfg *Config) {
		cfg.MaxSessionBytes = 1024
		cfg.MaxFileBytes = 1 << 20
	})
	token := registerUser(t, ts, "putbatchsize")

	tooLarge := map[string]any{
		"id": "big", "title": strings.Repeat("x", 2048), "createdAt": 1,
		"updatedAt": 1, "messages": []any{},
	}
	status := doJSON(t, ts, "PUT", "/api/sessions/batch", token, map[string]any{
		"sessions": []any{map[string]any{"id": "big", "baseRev": 0, "updatedAt": 1, "session": tooLarge}},
	}, nil)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized batch status=%d, want 413", status)
	}
}

// 「删除所有对话」是服务端一次事务完成的整体清空：上千条历史不能变成上千次 DELETE，
// 且每条墓碑必须拿到独立 rev，否则 /api/changes 翻页会在同一 rev 的中间被切断。
func TestDeleteAllSessions(t *testing.T) {
	ts, _ := testServer(t)
	alice := registerUser(t, ts, "clearalice")
	bob := registerUser(t, ts, "clearbob")

	session := func(id string) map[string]any {
		return map[string]any{
			"id": id, "title": id, "createdAt": 1, "updatedAt": 1, "messages": []any{},
		}
	}
	put := func(token, id string) {
		if status := doJSON(t, ts, "PUT", "/api/session/"+id, token, map[string]any{
			"baseRev": 0, "updatedAt": 1, "session": session(id),
		}, nil); status != http.StatusOK {
			t.Fatalf("put %s status=%d", id, status)
		}
	}
	for _, id := range []string{"all-1", "all-2", "all-3"} {
		put(alice, id)
	}
	put(bob, "all-1")

	var before struct {
		Rev int64 `json:"rev"`
	}
	doJSON(t, ts, "GET", "/api/state", alice, nil, &before)

	var cleared struct {
		Rev     int64 `json:"rev"`
		Deleted int64 `json:"deleted"`
	}
	if status := doJSON(t, ts, "DELETE", "/api/sessions", alice, nil, &cleared); status != http.StatusOK {
		t.Fatalf("delete all status=%d", status)
	}
	if cleared.Deleted != 3 || cleared.Rev != before.Rev+3 {
		t.Fatalf("cleared = %+v, want deleted=3 rev=%d", cleared, before.Rev+3)
	}

	// 全部变成墓碑，云端会话数归零。
	var state struct {
		Rev      int64 `json:"rev"`
		Sessions int64 `json:"sessions"`
	}
	doJSON(t, ts, "GET", "/api/state", alice, nil, &state)
	if state.Sessions != 0 || state.Rev != cleared.Rev {
		t.Fatalf("state = %+v", state)
	}

	// 逐页拉取必须能看到全部 3 条墓碑（验证每条墓碑有独立 rev）。
	seen := map[string]bool{}
	since := before.Rev
	for page := 0; page < 10; page++ {
		var changes changesResponse
		status := doJSON(t, ts, "GET",
			"/api/changes?since="+strconv.FormatInt(since, 10)+"&limit=2", alice, nil, &changes)
		if status != http.StatusOK {
			t.Fatalf("changes status=%d", status)
		}
		for _, item := range changes.Sessions {
			if !item.Deleted {
				t.Fatalf("change %s not deleted", item.ID)
			}
			seen[item.ID] = true
		}
		if !changes.HasMore {
			break
		}
		since = changes.NextSince
	}
	if len(seen) != 3 {
		t.Fatalf("pulled tombstones = %v, want all 3", seen)
	}

	// 再清一次：云端已空，不再推进游标、不广播。
	var again struct {
		Rev     int64 `json:"rev"`
		Deleted int64 `json:"deleted"`
	}
	doJSON(t, ts, "DELETE", "/api/sessions", alice, nil, &again)
	if again.Deleted != 0 || again.Rev != cleared.Rev {
		t.Fatalf("second clear = %+v", again)
	}

	// 用户隔离：bob 的会话不受影响。
	var bobState struct {
		Sessions int64 `json:"sessions"`
	}
	doJSON(t, ts, "GET", "/api/state", bob, nil, &bobState)
	if bobState.Sessions != 1 {
		t.Fatalf("bob sessions = %d, want 1", bobState.Sessions)
	}
	if status := doJSON(t, ts, "DELETE", "/api/sessions", "", nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated clear status=%d, want 401", status)
	}
}

// 注册同样是 bcrypt 计算，必须与登录一样按 IP 限流。
func TestRegisterRateLimited(t *testing.T) {
	ts, _ := testServerWithConfig(t, func(cfg *Config) { cfg.LoginLimit = 3 })
	// 一次成功注册会重置该 IP 的计数，先拿到一个可用账号用于验证登录不受注册限流影响。
	registerUser(t, ts, "rateuser")

	for attempt := 1; attempt <= 3; attempt++ {
		status := doJSON(t, ts, "POST", "/api/register", "", map[string]string{
			"username": uniqueName("short") + strconv.Itoa(attempt), "password": "x",
		}, nil)
		if status != http.StatusBadRequest {
			t.Fatalf("attempt %d status=%d, want 400", attempt, status)
		}
	}
	status := doJSON(t, ts, "POST", "/api/register", "", map[string]string{
		"username": uniqueName("short") + "x", "password": "x",
	}, nil)
	if status != http.StatusTooManyRequests {
		t.Fatalf("register over limit status=%d, want 429", status)
	}

	// 登录用的是独立计数：注册被限流不能连带把登录也封掉。
	var login struct {
		Token string `json:"token"`
	}
	status = doJSON(t, ts, "POST", "/api/login", "", map[string]string{
		"username": uniqueName("rateuser"), "password": "password123",
	}, &login)
	if status != http.StatusOK || login.Token == "" {
		t.Fatalf("login after register limit status=%d token=%q", status, login.Token)
	}
}
