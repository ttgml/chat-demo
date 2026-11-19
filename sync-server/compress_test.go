package main

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzipRequest(t *testing.T, handler http.Handler, accept string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	if accept != "" {
		req.Header.Set("Accept-Encoding", accept)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func TestCompressJSONGzipsJSON(t *testing.T) {
	handler := compressJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"payload": strings.Repeat("x", 4096)})
	}))
	recorder := gzipRequest(t, handler, "gzip, deflate, br")

	result := recorder.Result()
	defer result.Body.Close()
	if got := result.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := result.Header.Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want Accept-Encoding", got)
	}
	if got := result.Header.Get("Content-Length"); got != "" {
		t.Fatalf("Content-Length should be dropped, got %q", got)
	}
	reader, err := gzip.NewReader(result.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	var body map[string]string
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body["payload"]) != 4096 {
		t.Fatalf("payload length = %d, want 4096", len(body["payload"]))
	}
}

func TestCompressJSONPassthroughWithoutGzip(t *testing.T) {
	handler := compressJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
	}))
	recorder := gzipRequest(t, handler, "")

	if got := recorder.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty", got)
	}
	if !strings.Contains(recorder.Body.String(), `"ok":"1"`) {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestCompressJSONSkipsBinary(t *testing.T) {
	// 附件原件走 /api/file，Content-Length 对客户端很重要，不能压缩。
	handler := compressJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "4")
		_, _ = w.Write([]byte{0x89, 'P', 'N', 'G'})
	}))
	recorder := gzipRequest(t, handler, "gzip")

	if got := recorder.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty", got)
	}
	if got := recorder.Header().Get("Content-Length"); got != "4" {
		t.Fatalf("Content-Length = %q, want 4", got)
	}
}

func TestCompressJSONSkipsWebSocketUpgrade(t *testing.T) {
	var wrapped bool
	handler := compressJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, wrapped = w.(*gzipResponseWriter)
		w.WriteHeader(http.StatusBadRequest)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/watch", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if wrapped {
		t.Fatal("websocket upgrade request must not be wrapped by gzip writer")
	}
}

func TestCompressJSONSkipsNoContent(t *testing.T) {
	handler := compressJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNoContent)
	}))
	recorder := gzipRequest(t, handler, "gzip")

	if got := recorder.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty for 204", got)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("204 body should be empty, got %q", recorder.Body.String())
	}
}
