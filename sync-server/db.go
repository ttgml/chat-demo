package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const schema = `
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user_idx ON tokens(user_id);

-- 每个用户一个单调版本号；任何会话/附件的写操作都会 +1，作为增量同步游标。
CREATE TABLE IF NOT EXISTS user_rev (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rev     BIGINT NOT NULL DEFAULT 0
);

-- 会话按客户端 id 存储，payload 原样保存前端的 Session JSON，服务端不解析内部字段。
CREATE TABLE IF NOT EXISTS sessions (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    rev        BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted    BOOLEAN NOT NULL DEFAULT FALSE,
    payload    JSONB,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS sessions_changes_idx ON sessions(user_id, rev);

-- 附件原件按客户端 file id 存储，与任何会话解耦，避免跨设备引用被误删。
CREATE TABLE IF NOT EXISTS files (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id        TEXT NOT NULL,
    rev       BIGINT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    content   BYTEA NOT NULL,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS files_changes_idx ON files(user_id, rev);
`

// poolOptions 描述连接池上限；WebSocket 握手和每个 REST 请求都要借连接，
// 用户量上来后需要用环境变量调整。零值表示使用默认值。
type poolOptions struct {
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
}

func openDB(ctx context.Context, url string, opts poolOptions) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if opts.MaxConns > 0 {
		config.MaxConns = opts.MaxConns
	} else if config.MaxConns > 10 {
		// 与旧版本的写死值保持一致，避免默认把托管库的连接数吃满。
		config.MaxConns = 10
	}
	if opts.MinConns > 0 {
		config.MinConns = opts.MinConns
	}
	if opts.MaxConnLifetime > 0 {
		config.MaxConnLifetime = opts.MaxConnLifetime
	}
	if opts.MaxConnIdleTime > 0 {
		config.MaxConnIdleTime = opts.MaxConnIdleTime
	}
	if config.MaxConnLifetime == 0 {
		config.MaxConnLifetime = time.Hour
	}
	if config.MaxConnIdleTime == 0 {
		config.MaxConnIdleTime = 10 * time.Minute
	}

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return pool, nil
}

// nextRev 在事务内递增用户版本号并返回新值。调用方必须传入同一个 tx。
func nextRev(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	var rev int64
	err := tx.QueryRow(ctx, `
        INSERT INTO user_rev (user_id, rev) VALUES ($1, 1)
        ON CONFLICT (user_id) DO UPDATE SET rev = user_rev.rev + 1
        RETURNING rev
    `, userID).Scan(&rev)
	return rev, err
}

// currentRev 读取用户当前版本号；新用户视为 0。
func currentRev(ctx context.Context, pool *pgxpool.Pool, userID string) (int64, error) {
	var rev int64
	err := pool.QueryRow(ctx, `SELECT rev FROM user_rev WHERE user_id = $1`, userID).Scan(&rev)
	if err != nil {
		if isNoRows(err) {
			return 0, nil
		}
		return 0, err
	}
	return rev, nil
}
