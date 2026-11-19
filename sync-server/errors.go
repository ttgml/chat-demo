package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// apiError 是对外统一错误；Code 供客户端做条件分支，Message 可直接展示。
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func fail(status int, code, message string) *apiError {
	return &apiError{Status: status, Code: code, Message: message}
}

var (
	errUnauthorized = fail(http.StatusUnauthorized, "unauthorized", "login required")
	errBadRequest   = fail(http.StatusBadRequest, "bad_request", "invalid request")
	errConflict     = fail(http.StatusConflict, "conflict", "session changed on another device")
	errNotFound     = fail(http.StatusNotFound, "not_found", "resource not found")
	errTooLarge     = fail(http.StatusRequestEntityTooLarge, "too_large", "payload too large")
	errRateLimited  = fail(http.StatusTooManyRequests, "rate_limited", "too many attempts, try later")
)

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Warn("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, err error) {
	var api *apiError
	if errors.As(err, &api) {
		writeJSON(w, api.Status, map[string]string{"error": api.Code, "message": api.Message})
		return
	}
	slog.Error("unhandled error", "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{
		"error": "internal", "message": "internal server error",
	})
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
