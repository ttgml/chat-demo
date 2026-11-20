package main

import (
	"context"
	"net/http"
	"strings"
)

type contextKey string

const userIDKey contextKey = "userID"

// wildcardOrigin 表示允许任意来源。带凭证的跨域请求不允许把 Access-Control-Allow-Origin
// 设为字面量 "*"，因此命中通配时回显请求里的 Origin。
const wildcardOrigin = "*"

// clientIDHeader 由客户端在每个请求上携带，取值是当前页面实例的随机标识。
// 服务端用它跳过向写入方本人回推变更通知，避免自己上传的回环触发额外同步。
const clientIDHeader = "X-Sync-Client-Id"

// normalizeClientID 校验并归一化客户端标识。非法或缺失一律返回空串，
// 表示「未知来源」，此时广播不会跳过任何连接。
func normalizeClientID(raw string) string {
	id := strings.TrimSpace(raw)
	if id == "" || len(id) > 64 {
		return ""
	}
	for _, ch := range id {
		valid := ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' ||
			ch >= '0' && ch <= '9' || ch == '-' || ch == '_' || ch == '.'
		if !valid {
			return ""
		}
	}
	return id
}

func clientIDOf(r *http.Request) string {
	return normalizeClientID(r.Header.Get(clientIDHeader))
}

// allowAllOrigins 判断白名单里是否配置了 "*"。
func allowAllOrigins(allowed []string) bool {
	for _, origin := range allowed {
		if strings.TrimSpace(origin) == wildcardOrigin {
			return true
		}
	}
	return false
}

// normalizeOrigin 统一来源比较口径：忽略大小写、首尾空白与末尾斜杠。
func normalizeOrigin(origin string) string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(origin), "/"))
}

// cors 只允许配置中的来源；未配置时禁止跨域，避免默认放开带来的风险。
// 配置 "*" 时允许任意来源，但仍回显实际 Origin 而不是 "*"。
func cors(allowed []string, requireHTTPS bool) func(http.Handler) http.Handler {
	allowAll := allowAllOrigins(allowed)
	set := make(map[string]bool, len(allowed))
	for _, origin := range allowed {
		set[normalizeOrigin(origin)] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (allowAll || set[normalizeOrigin(origin)]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, "+clientIDHeader)
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
