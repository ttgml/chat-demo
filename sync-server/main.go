package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := loadConfig()
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db, err := openDB(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database error", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	auth := newAuthService(db, cfg.TokenTTL, cfg.LoginLimit, cfg.LoginWindow)
	hub := newWatchHub()
	srv := &Server{db: db, auth: auth, config: cfg, hub: hub}
	handler := routes(srv, cfg)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		// 上传大附件时不能设过短的 WriteTimeout；由 MaxBytesReader 限制体积。
	}

	go func() {
		slog.Info("sync server listening", "addr", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			cancel()
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
	case <-ctx.Done():
	}
	// WebSocket 连接已被 Hijack，Shutdown 不会关闭它们，需先主动断开。
	hub.closeAll()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
}

func routes(srv *Server, cfg Config) http.Handler {
	// 测试等场景可能直接构造 Server；保证 watch 端点始终有可用的 hub。
	if srv.hub == nil {
		srv.hub = newWatchHub()
	}
	mux := http.NewServeMux()

	// 公开接口：注册、登录。
	mux.HandleFunc("POST /api/register", srv.handleRegister)
	mux.HandleFunc("POST /api/login", srv.handleLogin)

	// WebSocket 在握手后的首帧携带 token，不能套用 requireAuth（浏览器
	// WebSocket API 无法设置 Authorization 头），鉴权在 handleWatch 内完成。
	mux.HandleFunc("GET /api/watch", srv.handleWatch)

	// 以下接口都需要认证。
	authOnly := requireAuth(srv.auth)
	mux.Handle("POST /api/logout", authOnly(http.HandlerFunc(srv.handleLogout)))
	mux.Handle("GET /api/state", authOnly(http.HandlerFunc(srv.handleState)))
	mux.Handle("GET /api/changes", authOnly(http.HandlerFunc(srv.handleChanges)))
	mux.Handle("GET /api/session/{id}", authOnly(http.HandlerFunc(srv.handleGetSession)))
	mux.Handle("PUT /api/session/{id}", authOnly(http.HandlerFunc(srv.handlePutSession)))
	mux.Handle("DELETE /api/session/{id}", authOnly(http.HandlerFunc(srv.handleDeleteSession)))
	mux.Handle("PUT /api/file/{id}", authOnly(http.HandlerFunc(srv.handlePutFile)))
	mux.Handle("GET /api/file/{id}", authOnly(http.HandlerFunc(srv.handleGetFile)))

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})

	// 全局上限取两者较大值并留出封装开销；各 handler 内再做自己的精确限额。
	globalLimit := cfg.MaxSessionBytes
	if cfg.MaxFileBytes > globalLimit {
		globalLimit = cfg.MaxFileBytes
	}
	var handler http.Handler = mux
	handler = maxBytes(globalLimit+(1<<20), handler)
	handler = cors(cfg.AllowedOrigins, cfg.RequireHTTPS)(handler)
	handler = securityHeaders(handler)
	return handler
}
