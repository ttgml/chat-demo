package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

type AuthService struct {
	db      *pgxpool.Pool
	ttl     time.Duration
	limiter *loginLimiter
}

func newAuthService(db *pgxpool.Pool, ttl time.Duration, limit int, window time.Duration) *AuthService {
	return &AuthService{db: db, ttl: ttl, limiter: newLoginLimiter(limit, window)}
}

func validateCredentials(username, password string) error {
	if !usernamePattern.MatchString(username) {
		return fail(http.StatusBadRequest, "invalid_username", "username must be 3-32 chars of letters, digits, _ . -")
	}
	if len(password) < 8 || len(password) > 128 {
		return fail(http.StatusBadRequest, "invalid_password", "password must be 8-128 chars")
	}
	return nil
}

func (a *AuthService) register(ctx context.Context, username, password string) (string, error) {
	if err := validateCredentials(username, password); err != nil {
		return "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	id, err := randomID()
	if err != nil {
		return "", err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)`, username).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return "", fail(http.StatusConflict, "user_exists", "username already taken")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)`, id, username, string(hash)); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO user_rev (user_id, rev) VALUES ($1, 0)`, id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return a.issueToken(ctx, id)
}

func (a *AuthService) login(ctx context.Context, username, password, ip string) (string, error) {
	if !a.limiter.allow(ip) {
		return "", errRateLimited
	}
	var id, hash string
	if err := a.db.QueryRow(ctx, `SELECT id, password_hash FROM users WHERE username = $1`, username).Scan(&id, &hash); err != nil {
		if isNoRows(err) {
			// 不区分用户不存在与密码错误，避免账号枚举。
			return "", fail(http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
		}
		return "", err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", fail(http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
	}
	a.limiter.reset(ip)
	return a.issueToken(ctx, id)
}

func (a *AuthService) issueToken(ctx context.Context, userID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	if _, err := a.db.Exec(ctx,
		`INSERT INTO tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		hashToken(token), userID, time.Now().Add(a.ttl),
	); err != nil {
		return "", err
	}
	return token, nil
}

func (a *AuthService) revoke(ctx context.Context, token string) error {
	_, err := a.db.Exec(ctx, `DELETE FROM tokens WHERE token_hash = $1`, hashToken(token))
	return err
}

// resolve 把 token 换成 user_id；过期的 token 顺手清理。
func (a *AuthService) resolve(ctx context.Context, token string) (string, error) {
	if token == "" {
		return "", errUnauthorized
	}
	var userID string
	var expires time.Time
	err := a.db.QueryRow(ctx,
		`SELECT user_id, expires_at FROM tokens WHERE token_hash = $1`, hashToken(token),
	).Scan(&userID, &expires)
	if err != nil {
		if isNoRows(err) {
			return "", errUnauthorized
		}
		return "", err
	}
	if time.Now().After(expires) {
		_, _ = a.db.Exec(ctx, `DELETE FROM tokens WHERE token_hash = $1`, hashToken(token))
		return "", errUnauthorized
	}
	return userID, nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// loginLimiter 按 IP 做简单的滑动窗口计数，只用于登录接口。
type loginLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	attempt map[string][]time.Time
}

func newLoginLimiter(limit int, window time.Duration) *loginLimiter {
	return &loginLimiter{limit: limit, window: window, attempt: make(map[string][]time.Time)}
}

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)
	times := l.attempt[ip][:0]
	for _, t := range l.attempt[ip] {
		if t.After(cutoff) {
			times = append(times, t)
		}
	}
	if len(times) >= l.limit {
		l.attempt[ip] = times
		return false
	}
	l.attempt[ip] = append(times, now)
	return true
}

func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	delete(l.attempt, ip)
	l.mu.Unlock()
}

func clientIP(r *http.Request) string {
	// 仅在部署者显式配置反向代理时才应信任该头；此处只取远端地址，
	// 避免伪造 X-Forwarded-For 绕过限流。
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func bearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}
