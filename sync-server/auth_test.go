package main

import (
	"strings"
	"testing"
	"time"
)

func TestValidateCredentials(t *testing.T) {
	cases := []struct {
		name, user, pass string
		wantErr          bool
	}{
		{"valid", "alice_01", "password123", false},
		{"dots and dashes", "a.b-c", "abcdefgh", false},
		{"short username", "ab", "password123", true},
		{"long username", strings.Repeat("a", 33), "password123", true},
		{"bad username chars", "a b", "password123", true},
		{"short password", "alice", "1234567", true},
		{"empty password", "alice", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateCredentials(tc.user, tc.pass)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateCredentials(%q, %q) err = %v, wantErr %v", tc.user, tc.pass, err, tc.wantErr)
			}
		})
	}
}

func TestTokenHashing(t *testing.T) {
	a := hashToken("token-a")
	b := hashToken("token-b")
	if a == b {
		t.Fatal("different tokens must hash differently")
	}
	if len(a) != 64 {
		t.Fatalf("hash length = %d, want 64", len(a))
	}
}

func TestLoginLimiter(t *testing.T) {
	l := newLoginLimiter(2, time.Minute)
	if !l.allow("1.2.3.4") {
		t.Fatal("first attempt should pass")
	}
	if !l.allow("1.2.3.4") {
		t.Fatal("second attempt should pass")
	}
	if l.allow("1.2.3.4") {
		t.Fatal("third attempt should be blocked")
	}
	if !l.allow("5.6.7.8") {
		t.Fatal("different ip should have its own budget")
	}
	l.reset("1.2.3.4")
	if !l.allow("1.2.3.4") {
		t.Fatal("reset should clear attempts")
	}
}

func TestValidID(t *testing.T) {
	cases := map[string]bool{
		"abc123":                 true,
		"a-b_c.d":                true,
		"":                       false,
		"a/b":                    false,
		"a b":                    false,
		"..":                     false,
		"a..b":                   false,
		strings.Repeat("x", 129): false,
	}
	for id, want := range cases {
		if got := validID(id); got != want {
			t.Errorf("validID(%q) = %v, want %v", id, got, want)
		}
	}
}
