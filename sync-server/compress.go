package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// gzipWriterPool 复用 gzip.Writer：每请求新建会带来 ~1MB 的压缩窗口分配。
var gzipWriterPool = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

// compressJSON 对 JSON 响应做 gzip 压缩。会话 payload 动辄数百 KB，
// 移动网络下能省掉大部分流量。
//
// 跳过两类请求：
//   - WebSocket 握手：需要 Hijack 底层连接，包装 ResponseWriter 会打断升级；
//   - 非文本响应（附件原件是图片/二进制，压缩收益低且会破坏 Content-Length 语义）。
func compressJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "" || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		cw := &gzipResponseWriter{
			ResponseWriter: w,
			gz:             gzipWriterPool.Get().(*gzip.Writer),
		}
		defer func() {
			_ = cw.Close()
			// 归还前解除对 ResponseWriter 的引用，否则池子会一直持有本次请求的 writer。
			cw.gz.Reset(io.Discard)
			gzipWriterPool.Put(cw.gz)
		}()
		next.ServeHTTP(cw, r)
	})
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		encoding := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if strings.EqualFold(encoding, "gzip") {
			return true
		}
	}
	return false
}

// compressible 只认 JSON 与纯文本；错误体也是 JSON，一起被压缩。
func compressible(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if index := strings.IndexByte(ct, ';'); index >= 0 {
		ct = strings.TrimSpace(ct[:index])
	}
	return ct == "application/json" || ct == "text/plain" || strings.HasSuffix(ct, "+json")
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
	compressing bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	// 204/304 没有正文；已有 Content-Encoding 的响应不二次压缩；
	// 其余情况按 handler 设置的 Content-Type 决定是否压缩。
	if status != http.StatusNoContent && status != http.StatusNotModified &&
		w.Header().Get("Content-Encoding") == "" && compressible(w.Header().Get("Content-Type")) {
		w.compressing = true
		// 压缩后长度未知，必须由 Go 重新分块传输；否则客户端会按原始长度截断。
		w.Header().Del("Content-Length")
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		w.gz.Reset(w.ResponseWriter)
	} else {
		w.gz.Reset(io.Discard)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.compressing {
		return w.gz.Write(p)
	}
	return w.ResponseWriter.Write(p)
}

// Close 写出 gzip 尾部；未压缩时什么也不做。
func (w *gzipResponseWriter) Close() error {
	if !w.compressing {
		return nil
	}
	w.compressing = false
	return w.gz.Close()
}

// Unwrap 让 http.ResponseController 仍能拿到底层 ResponseWriter。
func (w *gzipResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
