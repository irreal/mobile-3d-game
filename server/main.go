// Command server is the Nova Strike co-op server: HTTPS signalling (behind a TLS-terminating
// proxy) plus WebRTC data channels to every browser over one public UDP port.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	httpAddr       string
	udpPort        int
	publicIP       string
	allowedOrigins map[string]bool
	maxPlayers     int
	tickHz         int
}

func loadConfig() config {
	c := config{
		httpAddr:   env("HTTP_ADDR", ":8080"),
		udpPort:    envInt("RTC_UDP_PORT", 47100),
		publicIP:   env("PUBLIC_IP", ""),
		maxPlayers: envInt("MAX_PLAYERS", 16),
		tickHz:     envInt("TICK_HZ", 30),
	}
	c.allowedOrigins = map[string]bool{}
	for _, o := range strings.Split(env("ALLOWED_ORIGINS", "https://irreal.github.io,http://localhost:5173,http://localhost:4173"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.allowedOrigins[o] = true
		}
	}
	return c
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	cfg := loadConfig()
	if cfg.publicIP == "" {
		log.Printf("PUBLIC_IP not set: advertising local addresses only (fine for local testing)")
	}

	room := newRoom(cfg.maxPlayers)
	rtc, err := newRTC(cfg, room)
	if err != nil {
		log.Fatalf("webrtc setup: %v", err)
	}
	defer rtc.close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go room.run(ctx, time.Second/time.Duration(cfg.tickHz))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok " + strconv.Itoa(room.count()) + " players\n"))
	})
	mux.HandleFunc("/rtc/offer", rtc.handleOffer)

	srv := &http.Server{
		Addr:              cfg.httpAddr,
		Handler:           withCORS(cfg.allowedOrigins, mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	log.Printf("signalling on %s, WebRTC on udp/%d (public ip %q)", cfg.httpAddr, cfg.udpPort, cfg.publicIP)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http: %v", err)
	}
}

// healthcheck is for container health probes (the image has no shell or curl).
func healthcheck() int {
	addr := env("HTTP_ADDR", ":8080")
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func withCORS(allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			if !allowed[origin] && !allowed["*"] {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}
