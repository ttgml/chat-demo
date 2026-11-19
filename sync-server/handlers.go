package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	db     *pgxpool.Pool
	auth   *AuthService
	config Config
	// 按账号广播变更通知；单进程内有效，多实例部署见 README 的已知边界。
	hub *watchHub
}

// notifyChange 在事务提交后调用，只推送新游标，不推会话内容。
// 判空是为了让不关心实时通知的测试/调用方无需构造 hub。
func (s *Server) notifyChange(userID string, rev int64) {
	if s.hub != nil {
		s.hub.notify(userID, rev)
	}
}

func (s *Server) disconnectWatchToken(token string) {
	if s.hub != nil {
		s.hub.disconnectToken(hashToken(token))
	}
}

type credentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body credentialsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, err)
		return
	}
	token, err := s.auth.register(r.Context(), body.Username, body.Password)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"token": token})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body credentialsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, err)
		return
	}
	token, err := s.auth.login(r.Context(), body.Username, body.Password, clientIP(r))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.revoke(r.Context(), bearer(r)); err != nil {
		writeError(w, err)
		return
	}
	// token 已撤销，立即断开它建立的订阅连接（其它设备的 token 不受影响）。
	s.disconnectWatchToken(bearer(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleState 返回当前游标与云端会话数，供客户端判断是否需要拉取、展示云端概览。
// sessions 只统计未删除的会话（墓碑不计入）；它是新增字段，旧客户端会忽略。
func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	userID := userFrom(r)
	rev, err := currentRev(r.Context(), s.db, userID)
	if err != nil {
		writeError(w, err)
		return
	}
	var sessions int64
	err = s.db.QueryRow(r.Context(),
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND deleted = FALSE`, userID,
	).Scan(&sessions)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rev": rev, "sessions": sessions})
}

type change struct {
	ID        string `json:"id"`
	Rev       int64  `json:"rev"`
	UpdatedAt int64  `json:"updatedAt,omitempty"`
	Deleted   bool   `json:"deleted,omitempty"`
	MimeType  string `json:"mimeType,omitempty"`
}

type rawChange struct {
	kind           string
	id             string
	rev, updatedAt int64
	deleted        bool
	mimeType       string
}

type changesResponse struct {
	// Rev 是服务端当前全局游标；只在没有更多变更时可作为下次 since 使用。
	Rev int64 `json:"rev"`
	// NextSince 是客户端下一次请求应携带的 since；有分页时它是本页最大 rev，不是 Rev。
	NextSince int64    `json:"nextSince"`
	Sessions  []change `json:"sessions"`
	Files     []change `json:"files"`
	HasMore   bool     `json:"hasMore"`
}

// handleChanges 增量拉取：把会话与附件变更统一按 rev 排序后分页，含删除墓碑。
// 统一排序是必须的：若两类分别分页，先返回附件的大 rev 会让会话中间的变更被跳过。
func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil || since < 0 {
		writeError(w, fail(http.StatusBadRequest, "invalid_since", "since must be a non-negative integer"))
		return
	}
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	userID := userFrom(r)
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	head, err := currentRevTx(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := tx.Query(r.Context(), `
        SELECT kind, id, rev, updated_at, deleted, mime_type FROM (
            SELECT 'session'::text AS kind, id, rev, updated_at, deleted, ''::text AS mime_type
                FROM sessions WHERE user_id = $1 AND rev > $2
            UNION ALL
            SELECT 'file'::text AS kind, id, rev, 0::bigint, FALSE, mime_type
                FROM files WHERE user_id = $1 AND rev > $2
        ) changes
        ORDER BY rev ASC, kind ASC, id ASC
        LIMIT $3
    `, userID, since, limit+1)
	if err != nil {
		writeError(w, err)
		return
	}
	var batch []rawChange
	for rows.Next() {
		var item rawChange
		if err := rows.Scan(&item.kind, &item.id, &item.rev, &item.updatedAt, &item.deleted, &item.mimeType); err != nil {
			rows.Close()
			writeError(w, err)
			return
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}

	result := changesResponse{Rev: head, NextSince: head, Sessions: []change{}, Files: []change{}}
	if len(batch) > limit {
		batch = batch[:limit]
		result.HasMore = true
	}
	for _, item := range batch {
		c := change{ID: item.id, Rev: item.rev}
		if item.kind == "session" {
			c.UpdatedAt, c.Deleted = item.updatedAt, item.deleted
			result.Sessions = append(result.Sessions, c)
		} else {
			c.MimeType = item.mimeType
			result.Files = append(result.Files, c)
		}
	}
	if len(batch) > 0 {
		result.NextSince = batch[len(batch)-1].rev
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleGetSession 返回会话原始 JSON，服务端不解释内部字段。
func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, errBadRequest)
		return
	}
	var rev, updatedAt int64
	var deleted bool
	var payload []byte
	err := s.db.QueryRow(r.Context(), `
        SELECT rev, updated_at, deleted, COALESCE(payload, 'null'::jsonb) FROM sessions
        WHERE user_id = $1 AND id = $2
    `, userFrom(r), id).Scan(&rev, &updatedAt, &deleted, &payload)
	if err != nil {
		if isNoRows(err) {
			writeError(w, errNotFound)
		} else {
			writeError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rev": rev, "updatedAt": updatedAt, "deleted": deleted, "session": json.RawMessage(payload),
	})
}

type putSessionRequest struct {
	BaseRev   int64           `json:"baseRev"`
	UpdatedAt int64           `json:"updatedAt"`
	Session   json.RawMessage `json:"session"`
}

// handlePutSession 用 baseRev 做乐观锁：与服务端版本不一致时返回 409 和当前版本。
func (s *Server) handlePutSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, errBadRequest)
		return
	}
	var body putSessionRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.Session) == 0 || !json.Valid(body.Session) {
		writeError(w, fail(http.StatusBadRequest, "invalid_session", "session must be valid JSON"))
		return
	}
	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var storedRev int64
	var deleted bool
	err = tx.QueryRow(r.Context(),
		`SELECT rev, deleted FROM sessions WHERE user_id = $1 AND id = $2`, userID, id,
	).Scan(&storedRev, &deleted)
	if err != nil && !isNoRows(err) {
		writeError(w, err)
		return
	}
	if isNoRows(err) {
		storedRev = 0
	}
	if storedRev != body.BaseRev || deleted {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "conflict", "message": errConflict.Message, "serverRev": storedRev, "deleted": deleted,
		})
		return
	}
	newRev, err := nextRev(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `
        INSERT INTO sessions (user_id, id, rev, updated_at, deleted, payload)
        VALUES ($1, $2, $3, $4, FALSE, $5)
        ON CONFLICT (user_id, id) DO UPDATE SET
            rev = EXCLUDED.rev, updated_at = EXCLUDED.updated_at,
            deleted = FALSE, payload = EXCLUDED.payload
    `, userID, id, newRev, body.UpdatedAt, body.Session)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	s.notifyChange(userID, newRev)
	writeJSON(w, http.StatusOK, map[string]any{"rev": newRev})
}

// handleDeleteSession 写墓碑而不是物理删除，保证其他设备能收到删除事件。
func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, errBadRequest)
		return
	}
	baseRev, err := strconv.ParseInt(r.URL.Query().Get("baseRev"), 10, 64)
	if err != nil || baseRev < 0 {
		writeError(w, fail(http.StatusBadRequest, "invalid_base_rev", "baseRev must be a non-negative integer"))
		return
	}
	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var storedRev int64
	var deleted bool
	err = tx.QueryRow(r.Context(),
		`SELECT rev, deleted FROM sessions WHERE user_id = $1 AND id = $2`, userID, id,
	).Scan(&storedRev, &deleted)
	if err != nil && !isNoRows(err) {
		writeError(w, err)
		return
	}
	if isNoRows(err) {
		storedRev = 0
	}
	if storedRev != baseRev || deleted {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "conflict", "message": errConflict.Message, "serverRev": storedRev, "deleted": deleted,
		})
		return
	}
	newRev, err := nextRev(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `
        INSERT INTO sessions (user_id, id, rev, updated_at, deleted, payload)
        VALUES ($1, $2, $3, 0, TRUE, NULL)
        ON CONFLICT (user_id, id) DO UPDATE SET rev = EXCLUDED.rev, deleted = TRUE, payload = NULL
    `, userID, id, newRev)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	s.notifyChange(userID, newRev)
	writeJSON(w, http.StatusOK, map[string]any{"rev": newRev})
}

// handlePutFile 附件按 file id 幂等覆盖；客户端上传前会先比对版本。
func (s *Server) handlePutFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, errBadRequest)
		return
	}
	content, err := io.ReadAll(io.LimitReader(r.Body, s.config.MaxFileBytes+1))
	if err != nil {
		writeError(w, errBadRequest)
		return
	}
	if int64(len(content)) > s.config.MaxFileBytes {
		writeError(w, errTooLarge)
		return
	}
	mime := r.Header.Get("Content-Type")
	if len(mime) > 128 {
		mime = "application/octet-stream"
	}
	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	newRev, err := nextRev(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `
        INSERT INTO files (user_id, id, rev, mime_type, content) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, id) DO UPDATE SET
            rev = EXCLUDED.rev, mime_type = EXCLUDED.mime_type, content = EXCLUDED.content
    `, userID, id, newRev, mime, content)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	s.notifyChange(userID, newRev)
	writeJSON(w, http.StatusOK, map[string]any{"rev": newRev})
}

func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID(id) {
		writeError(w, errBadRequest)
		return
	}
	var mime string
	var content []byte
	err := s.db.QueryRow(r.Context(),
		`SELECT mime_type, content FROM files WHERE user_id = $1 AND id = $2`, userFrom(r), id,
	).Scan(&mime, &content)
	if err != nil {
		if isNoRows(err) {
			writeError(w, errNotFound)
		} else {
			writeError(w, err)
		}
		return
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = io.Copy(w, bytes.NewReader(content))
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return errBadRequest
		}
		return fail(http.StatusBadRequest, "invalid_json", "request body is not valid JSON")
	}
	return nil
}

func currentRevTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	var rev int64
	err := tx.QueryRow(ctx, `SELECT rev FROM user_rev WHERE user_id = $1`, userID).Scan(&rev)
	if err != nil {
		if isNoRows(err) {
			return 0, nil
		}
		return 0, err
	}
	return rev, nil
}
