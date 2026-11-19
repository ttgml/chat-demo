package main

import (
	"context"
	"net/http"
	"strings"
)

type contextKey string

const userIDKey contextKey = "userID"

// cors 只允许配置中的来源；未配置时禁止跨域，避免默认放开带来的风险。
func cors(allowed []string, requireHTTPS bool) func(http.Handler) http.Handler {
	set := make(map[string]bool, len(allowed))
	for _, origin := range allowed {
		set[origin] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && set[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length")
				w.Header().Set("Access-Control-Max-Age", "600")
				if requireHTTPS {
					w.Header().Set("Strict-Transport-Security", "max-age=31536000")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// requireAuth 解析 Bearer token，并把 user_id 注入 context；下游所有查询都基于它。
func requireAuth(auth *AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, err := auth.resolve(r.Context(), bearer(r))
			if err != nil {
				writeError(w, err)
				return
			}
			ctx := context.WithValue(r.Context(), userIDKey, id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func userFrom(r *http.Request) string {
	id, _ := r.Context().Value(userIDKey).(string)
	return id
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func maxBytes(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

// validID 校验客户端提供的会话/附件 id，防止异常路径与超长键。
func validID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, ch := range id {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
			ch == '-' || ch == '_' || ch == '.' {
			continue
		}
		return false
	}
	return !strings.Contains(id, "..")
}
