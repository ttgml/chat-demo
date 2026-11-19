package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 从环境变量读取；所有配置项都有适合自部署的默认值。
type Config struct {
	Addr            string
	DatabaseURL     string
	AllowedOrigins  []string
	RequireHTTPS    bool
	TokenTTL        time.Duration
	MaxSessionBytes int64
	MaxFileBytes    int64
	LoginLimit      int
	LoginWindow     time.Duration
}

func loadConfig() (Config, error) {
	cfg := Config{
		Addr:            env("SYNC_ADDR", ":8080"),
		DatabaseURL:     os.Getenv("SYNC_DATABASE_URL"),
		RequireHTTPS:    envBool("SYNC_REQUIRE_HTTPS", false),
		TokenTTL:        envDuration("SYNC_TOKEN_TTL", 30*24*time.Hour),
		MaxSessionBytes: envInt64("SYNC_MAX_SESSION_BYTES", 8<<20),
		MaxFileBytes:    envInt64("SYNC_MAX_FILE_BYTES", 32<<20),
		LoginLimit:      int(envInt64("SYNC_LOGIN_LIMIT", 10)),
		LoginWindow:     envDuration("SYNC_LOGIN_WINDOW", 15*time.Minute),
	}

	origins := os.Getenv("SYNC_ALLOWED_ORIGINS")
	if origins == "" {
		cfg.AllowedOrigins = nil
	} else {
		for _, item := range strings.Split(origins, ",") {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, trimmed)
			}
		}
	}

	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("SYNC_DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/chatsync?sslmode=disable)")
	}
	if cfg.TokenTTL <= 0 {
		return cfg, fmt.Errorf("SYNC_TOKEN_TTL must be positive")
	}
	if cfg.MaxSessionBytes <= 0 || cfg.MaxFileBytes <= 0 {
		return cfg, fmt.Errorf("size limits must be positive")
	}
	if cfg.LoginLimit <= 0 || cfg.LoginWindow <= 0 {
		return cfg, fmt.Errorf("login limit and window must be positive")
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envInt64(key string, fallback int64) int64 {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
