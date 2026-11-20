package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORS(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	cases := []struct {
		name       string
		allowed    []string
		origin     string
		wantAllow  string // 空表示不返回 Access-Control-Allow-Origin
		wantStatus int
	}{
		{"allowlisted", []string{"http://localhost:8090"}, "http://localhost:8090", "http://localhost:8090", http.StatusOK},
		{"trailing slash", []string{"http://localhost:8090/"}, "http://localhost:8090", "http://localhost:8090", http.StatusOK},
		{"case insensitive", []string{"https://App.Example.com"}, "https://app.example.com", "https://app.example.com", http.StatusOK},
		{"not allowlisted", []string{"http://localhost:8090"}, "https://evil.example.com", "", http.StatusOK},
		{"empty config", nil, "http://localhost:8090", "", http.StatusOK},
		{"no origin", []string{"http://localhost:8090"}, "", "", http.StatusOK},
		{"wildcard echoes origin", []string{"*"}, "https://any.example.com", "https://any.example.com", http.StatusOK},
		{"wildcard preflight", []string{"*"}, "http://localhost:8090", "http://localhost:8090", http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
			if tc.name == "wildcard preflight" {
				req = httptest.NewRequest(http.MethodOptions, "/api/state", nil)
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			cors(tc.allowed, false)(next).ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d", rec.Code, tc.wantStatus)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != tc.wantAllow {
				t.Fatalf("allow-origin: got %q want %q", got, tc.wantAllow)
			}
			if tc.wantAllow != "" {
				if rec.Header().Get("Vary") != "Origin" {
					t.Fatalf("missing Vary: Origin")
				}
				if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
					t.Fatalf("missing allow-credentials")
				}
			}
		})
	}
}
