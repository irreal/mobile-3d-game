package main

import (
	"math/rand/v2"
	"sort"
	"sync"
	"time"
)

const (
	// Time between announcing a wave and its start, so every client has the message in time.
	waveLead = 1200 * time.Millisecond
	// A wave starts this long after the first player is ready, even if others aren't yet.
	readyTimeout = 20 * time.Second
	// Enemy and orb ids above this are rejected (clients number them well below).
	maxEntityID   = 1 << 16
	maxDamageHits = 64
)

// clientEvent is any JSON message a client sends on the events channel.
type clientEvent struct {
	T  string       `json:"t"`
	C  float64      `json:"c"`
	W  int          `json:"w"`
	ID int          `json:"id"`
	H  [][2]float64 `json:"h"`
}

type sender interface {
	send(id uint16, v any)
	broadcast(v any, except uint16)
}

// game is the shared run every co-op player is in. Clients simulate waves themselves from the
// seed and start time the server hands out; the server decides when each wave starts and is the
// referee for kills and power-orb pickups, so each enemy or orb counts once.
type game struct {
	mu   sync.Mutex
	out  sender
	rand func() uint32

	wave  int
	seed  uint32
	atMs  int64
	kills map[int]bool
	picks map[int]bool
	// Players in the run, and the wave each ready player asked for.
	players  map[uint16]bool
	ready    map[uint16]int
	deadline time.Time
}

func newGame(out sender) *game {
	return &game{
		out:     out,
		rand:    rand.Uint32,
		kills:   map[int]bool{},
		picks:   map[int]bool{},
		players: map[uint16]bool{},
		ready:   map[uint16]int{},
	}
}

func (g *game) handle(id uint16, e clientEvent, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch e.T {
	case "ready":
		g.onReady(id, e.W, now)
	case "out":
		g.leaveLocked(id, false, now)
	case "kill", "pick":
		if !g.players[id] || e.W != g.wave || e.ID < 0 || e.ID >= maxEntityID {
			return
		}
		seen := g.kills
		if e.T == "pick" {
			seen = g.picks
		}
		if seen[e.ID] {
			return
		}
		seen[e.ID] = true
		g.out.broadcast(map[string]any{"t": e.T, "w": e.W, "id": e.ID, "by": id}, id)
	case "dmg":
		if !g.players[id] || e.W != g.wave || len(e.H) == 0 || len(e.H) > maxDamageHits {
			return
		}
		g.out.broadcast(map[string]any{"t": "dmg", "w": e.W, "by": id, "h": e.H}, id)
	}
}

// leave drops a disconnected player from the run.
func (g *game) leave(id uint16, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.leaveLocked(id, true, now)
}

// tick starts a wave whose ready timeout ran out.
func (g *game) tick(now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.deadline.IsZero() && !now.Before(g.deadline) {
		g.startIfReady(now, true)
	}
}

func (g *game) onReady(id uint16, wave int, now time.Time) {
	if wave < 1 || wave > 255 {
		return
	}
	g.players[id] = true
	if g.wave > 0 && wave <= g.wave {
		// Joining late, or the squad started without them: catch up with the wave in progress.
		delete(g.ready, id)
		g.out.send(id, g.waveMessage())
		return
	}
	g.ready[id] = wave
	if g.deadline.IsZero() {
		g.deadline = now.Add(readyTimeout)
	}
	g.startIfReady(now, false)
}

// leaveLocked drops a player from the run; `quit` if they disconnected rather than game-overed.
func (g *game) leaveLocked(id uint16, quit bool, now time.Time) {
	if !g.players[id] {
		return
	}
	delete(g.players, id)
	delete(g.ready, id)
	g.out.broadcast(map[string]any{"t": "out", "id": id, "quit": quit}, id)
	if len(g.players) == 0 {
		g.wave = 0
		g.deadline = time.Time{}
		clear(g.ready)
		return
	}
	g.startIfReady(now, false)
}

// startIfReady starts the next wave once every player in the run is ready for it (or `force`).
func (g *game) startIfReady(now time.Time, force bool) {
	if len(g.ready) == 0 {
		g.deadline = time.Time{}
		return
	}
	if !force {
		for id := range g.players {
			if _, ok := g.ready[id]; !ok {
				return
			}
		}
	}
	// Normally the wave after this one; after a server restart, wherever the players are.
	next := 0
	for _, w := range g.ready {
		if next == 0 || w < next {
			next = w
		}
	}
	next = max(next, g.wave+1)

	g.wave = next
	g.seed = g.rand()
	g.atMs = now.Add(waveLead).UnixMilli()
	clear(g.kills)
	clear(g.picks)
	clear(g.ready)
	g.deadline = time.Time{}
	g.out.broadcast(g.waveMessage(), 0)
}

func (g *game) waveMessage() map[string]any {
	return map[string]any{
		"t":     "wave",
		"w":     g.wave,
		"seed":  g.seed,
		"at":    g.atMs,
		"kills": sortedKeys(g.kills),
		"picks": sortedKeys(g.picks),
	}
}

func sortedKeys(m map[int]bool) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}
