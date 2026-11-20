package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	token, err := s.auth.register(r.Context(), body.Username, body.Password, clientIP(r))
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

const (
	// 一次批量拉取的会话数上限，与 /api/changes 的 limit 上限一致。
	maxBatchSessions = 500
	// 单次批量响应的 payload 字节预算。超过后停手并置 truncated，
	// 客户端对缺失的 id 退回单条接口，避免一次响应把内存/流量打爆。
	maxBatchPayloadBytes = 16 << 20
)

type batchSessionsRequest struct {
	IDs []string `json:"ids"`
}

type batchSession struct {
	ID        string          `json:"id"`
	Rev       int64           `json:"rev"`
	UpdatedAt int64           `json:"updatedAt"`
	Deleted   bool            `json:"deleted"`
	Session   json.RawMessage `json:"session"`
}

type batchSessionsResponse struct {
	Sessions []batchSession `json:"sessions"`
	// Truncated 表示因 payload 总量超过预算被提前截断，缺失的 id 需要回退单条接口。
	Truncated bool `json:"truncated,omitempty"`
}

// handleGetSessions 批量返回会话原始 JSON（POST /api/sessions/batch）。
// 语义与 GET /api/session/{id} 完全一致（含墓碑）；从不存在的 id 直接不出现在响应里。
// 客户端增量拉取一页最多 200 条，逐条 GET 会变成 200 次请求 + 400 次查询，
// 批量接口把这两个数字降成 1（或按 ids 分块后的少数几次）。
func (s *Server) handleGetSessions(w http.ResponseWriter, r *http.Request) {
	var body batchSessionsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.IDs) == 0 || len(body.IDs) > maxBatchSessions {
		writeError(w, fail(http.StatusBadRequest, "invalid_ids",
			fmt.Sprintf("ids must contain 1-%d entries", maxBatchSessions)))
		return
	}
	ids := make([]string, 0, len(body.IDs))
	seen := make(map[string]bool, len(body.IDs))
	for _, id := range body.IDs {
		if !validID(id) {
			writeError(w, fail(http.StatusBadRequest, "invalid_id",
				"id must be 1-128 chars of letters, digits, _ . -"))
			return
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	rows, err := s.db.Query(r.Context(), `
        SELECT id, rev, updated_at, deleted, COALESCE(payload, 'null'::jsonb) FROM sessions
        WHERE user_id = $1 AND id = ANY($2)
    `, userFrom(r), ids)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	found := make(map[string]batchSession, len(ids))
	var size int64
	truncated := false
	for rows.Next() {
		var item batchSession
		if err := rows.Scan(&item.ID, &item.Rev, &item.UpdatedAt, &item.Deleted, &item.Session); err != nil {
			writeError(w, err)
			return
		}
		if !truncated {
			// 单个 payload 可能就很大，所以按累加后的总量判断，且至少返回一条。
			size += int64(len(item.Session))
			if len(found) > 0 && size > maxBatchPayloadBytes {
				truncated = true
			}
		}
		if truncated {
			continue
		}
		found[item.ID] = item
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	rows.Close()

	result := batchSessionsResponse{Sessions: make([]batchSession, 0, len(found)), Truncated: truncated}
	// 按请求顺序返回，客户端对账时不必再排序。
	for _, id := range ids {
		if item, ok := found[id]; ok {
			result.Sessions = append(result.Sessions, item)
		}
	}
	writeJSON(w, http.StatusOK, result)
}

type putSessionRequest struct {
	BaseRev   int64           `json:"baseRev"`
	UpdatedAt int64           `json:"updatedAt"`
	Session   json.RawMessage `json:"session"`
	// Revive 表示客户端已知该 id 是墓碑，并显式要求恢复（导入备份时的全量替换）。
	// 默认不带此标志时仍拒绝覆盖墓碑，避免离线设备的旧编辑把已删除会话「复活」。
	Revive bool `json:"revive"`
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
	if int64(len(body.Session)) > s.config.MaxSessionBytes {
		writeError(w, errTooLarge)
		return
	}
	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	// 先递增用户版本号拿到 user_rev 行锁，再检查 baseRev。
	// 若先 SELECT 后递增，两个并发 PUT 会同时读到旧 rev 并都通过检查，
	// 后提交者静默覆盖先提交者且双方都收到 200。
	newRev, err := nextRev(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}

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
	if storedRev != body.BaseRev || (deleted && !body.Revive) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "conflict", "message": errConflict.Message, "serverRev": storedRev, "deleted": deleted,
		})
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

type putSessionsRequest struct {
	Sessions []putBatchSession `json:"sessions"`
}

// putBatchSession 复用单条接口的请求体（嵌入字段被提升），只额外带一个 id。
type putBatchSession struct {
	ID string `json:"id"`
	putSessionRequest
}

// putSessionResult 批量上传的单条结果。Conflict 为 true 时各字段语义与单条接口的 409 响应一致，
// 客户端用它走同一套冲突解决逻辑；服务端不会因为部分冲突而拒绝整批。
type putSessionResult struct {
	ID        string `json:"id"`
	Rev       int64  `json:"rev,omitempty"`
	Conflict  bool   `json:"conflict,omitempty"`
	ServerRev int64  `json:"serverRev,omitempty"`
	Deleted   bool   `json:"deleted,omitempty"`
}

type putSessionsResponse struct {
	Results []putSessionResult `json:"results"`
}

const (
	// 一次批量上传的会话数上限，与批量拉取的上限保持同一量级。
	maxPutBatchSessions = 100
	// 单次批量上传的请求体预算。批量 body 是 N 条完整会话，与单条会话上限无关，
	// 按总量单独限制；客户端会按字节预算切批，超过时退回逐条 PUT。
	maxPutBatchBytes = 16 << 20
)

// handlePutSessions 批量上传会话（PUT /api/sessions/batch）。
//
// 语义与 PUT /api/session/{id} 完全一致：逐条 baseRev 乐观锁，墓碑默认拒绝覆盖。
// 区别只在于整批共用一个事务：导入 1000 条历史时，逐条 PUT 意味着 1000 次
// 鉴权查库 + 1000 个事务 + 1000 次广播；这里降成一次入库、一次广播。
// 冲突不算整批失败：不冲突的会话照常落库，冲突项在 results 里带 serverRev/deleted，
// 由客户端复用单条接口的冲突解决逻辑。
func (s *Server) handlePutSessions(w http.ResponseWriter, r *http.Request) {
	var body putSessionsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.Sessions) == 0 || len(body.Sessions) > maxPutBatchSessions {
		writeError(w, fail(http.StatusBadRequest, "invalid_sessions",
			fmt.Sprintf("sessions must contain 1-%d entries", maxPutBatchSessions)))
		return
	}
	ids := make([]string, 0, len(body.Sessions))
	seen := make(map[string]bool, len(body.Sessions))
	for _, item := range body.Sessions {
		if !validID(item.ID) {
			writeError(w, fail(http.StatusBadRequest, "invalid_id",
				"id must be 1-128 chars of letters, digits, _ . -"))
			return
		}
		if seen[item.ID] {
			writeError(w, fail(http.StatusBadRequest, "duplicate_id", "session ids must be unique"))
			return
		}
		seen[item.ID] = true
		if item.BaseRev < 0 {
			writeError(w, fail(http.StatusBadRequest, "invalid_base_rev", "baseRev must be a non-negative integer"))
			return
		}
		if len(item.Session) == 0 || !json.Valid(item.Session) {
			writeError(w, fail(http.StatusBadRequest, "invalid_session", "session must be valid JSON"))
			return
		}
		if int64(len(item.Session)) > s.config.MaxSessionBytes {
			writeError(w, errTooLarge)
			return
		}
		ids = append(ids, item.ID)
	}

	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	// 与单条 PUT 一样，先递增 user_rev 拿到行锁再检查 baseRev，
	// 否则并发的整批写入会同时读到旧版本号并双双通过乐观锁检查。
	newRev, err := nextRevN(r.Context(), tx, userID, len(ids))
	if err != nil {
		writeError(w, err)
		return
	}

	// 一次取回已有的会话版本，避免逐条查询（1000 条就是 1000 次往返）。
	rows, err := tx.Query(r.Context(),
		`SELECT id, rev, deleted FROM sessions WHERE user_id = $1 AND id = ANY($2)`, userID, ids)
	if err != nil {
		writeError(w, err)
		return
	}
	type storedSession struct {
		rev     int64
		deleted bool
	}
	stored := make(map[string]storedSession, len(ids))
	for rows.Next() {
		var id string
		var item storedSession
		if err := rows.Scan(&id, &item.rev, &item.deleted); err != nil {
			rows.Close()
			writeError(w, err)
			return
		}
		stored[id] = item
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}

	type appliedSession struct {
		putBatchSession
		rev int64
	}
	firstRev := newRev - int64(len(ids)) + 1
	results := make([]putSessionResult, 0, len(body.Sessions))
	applied := make([]appliedSession, 0, len(body.Sessions))
	for index, item := range body.Sessions {
		// 未存储过的 id 取零值：rev=0、deleted=false，与单条 PUT 的判断完全一致。
		current := stored[item.ID]
		if current.rev != item.BaseRev || (current.deleted && !item.Revive) {
			results = append(results, putSessionResult{
				ID: item.ID, Conflict: true, ServerRev: current.rev, Deleted: current.deleted,
			})
			continue
		}
		applied = append(applied, appliedSession{putBatchSession: item, rev: firstRev + int64(index)})
		results = append(results, putSessionResult{ID: item.ID, Rev: firstRev + int64(index)})
	}

	if len(applied) > 0 {
		// 流水线提交所有写入：1000 条会话依然是 1 次往返，而不是 1000 次。
		batch := &pgx.Batch{}
		for _, item := range applied {
			batch.Queue(`
                INSERT INTO sessions (user_id, id, rev, updated_at, deleted, payload)
                VALUES ($1, $2, $3, $4, FALSE, $5)
                ON CONFLICT (user_id, id) DO UPDATE SET
                    rev = EXCLUDED.rev, updated_at = EXCLUDED.updated_at,
                    deleted = FALSE, payload = EXCLUDED.payload
            `, userID, item.ID, item.rev, item.UpdatedAt, item.Session)
		}
		br := tx.SendBatch(r.Context(), batch)
		for range applied {
			if _, err := br.Exec(); err != nil {
				br.Close()
				writeError(w, err)
				return
			}
		}
		if err := br.Close(); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if len(applied) > 0 {
		// 一批只广播一次：其它设备收到后仍走增量拉取，不需要逐条通知。
		s.notifyChange(userID, newRev)
	}
	writeJSON(w, http.StatusOK, putSessionsResponse{Results: results})
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

	// 与 PUT 一样先拿 user_rev 行锁，保证并发删除时 baseRev 检查不会被两个事务同时通过。
	newRev, err := nextRev(r.Context(), tx, userID)
	if err != nil {
		writeError(w, err)
		return
	}

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

// handleDeleteSessions 清空当前账号的全部会话（DELETE /api/sessions）。
//
// 「删除所有对话」原先由客户端为每个会话各发一次 DELETE /api/session/{id}：
// 上千条历史就是上千次请求、上千个事务和上千次广播；而且只能删掉本机已知的会话，
// 其它设备上传过、本机尚未拉到的会话会在下一次 pull 时「复活」。
// 这里在一个事务里给全部会话写墓碑，一次广播，并能连带清掉本机没见过的会话。
func (s *Server) handleDeleteSessions(w http.ResponseWriter, r *http.Request) {
	userID := userFrom(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	// 先给 user_rev 行加锁（不递增），再统计要删的会话：其它写操作（PUT/DELETE/附件）
	// 都先 nextRev，所以拿到锁之后它们插不进来，计数与随后的版本号预留才是稳定的。
	if _, err := tx.Exec(r.Context(),
		`UPDATE user_rev SET rev = rev WHERE user_id = $1`, userID,
	); err != nil {
		writeError(w, err)
		return
	}

	var count int64
	err = tx.QueryRow(r.Context(),
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND deleted = FALSE`, userID,
	).Scan(&count)
	if err != nil {
		writeError(w, err)
		return
	}
	if count == 0 {
		// 云端已经是空的：不推进游标、不广播，也不写任何东西。
		rev, err := currentRevTx(r.Context(), tx, userID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rev": rev, "deleted": 0})
		return
	}
	// 一次把 count 个版本号全部预留：newRev 是本批最后一条墓碑的 rev。
	newRev, err := nextRevN(r.Context(), tx, userID, int(count))
	if err != nil {
		writeError(w, err)
		return
	}

	// 每条墓碑拿一个独立的 rev：/api/changes 分页按 rev > since 推进，
	// 若上千条共用一个 rev，翻页会在同一 rev 的中间被切断，后面的会话其它设备永远拉不到。
	_, err = tx.Exec(r.Context(), `
        WITH targets AS (
            SELECT id, row_number() OVER (ORDER BY id) AS seq
            FROM sessions WHERE user_id = $1 AND deleted = FALSE
        )
        INSERT INTO sessions (user_id, id, rev, updated_at, deleted, payload)
        SELECT $1, id, $2 + seq - 1, 0, TRUE, NULL FROM targets
        ON CONFLICT (user_id, id) DO UPDATE SET
            rev = EXCLUDED.rev, deleted = TRUE, payload = NULL
    `, userID, newRev-int64(count)+1)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	s.notifyChange(userID, newRev)
	writeJSON(w, http.StatusOK, map[string]any{"rev": newRev, "deleted": count})
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
