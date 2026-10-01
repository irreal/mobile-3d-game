package main

import (
	"testing"
	"time"
)

type sent struct {
	to, except uint16
	v          map[string]any
}

type recorder struct{ msgs []sent }

func (r *recorder) send(id uint16, v any) {
	r.msgs = append(r.msgs, sent{to: id, v: v.(map[string]any)})
}

func (r *recorder) broadcast(v any, except uint16) {
	r.msgs = append(r.msgs, sent{except: except, v: v.(map[string]any)})
}

func (r *recorder) take() []sent {
	m := r.msgs
	r.msgs = nil
	return m
}

func newTestGame() (*game, *recorder) {
	rec := &recorder{}
	g := newGame(rec)
	g.rand = func() uint32 { return 42 }
	return g, rec
}

func TestWaveWaitsForEveryPlayer(t *testing.T) {
	g, rec := newTestGame()
	now := time.UnixMilli(1_000_000)

	g.handle(1, clientEvent{T: "ready", W: 1}, now)
	msgs := rec.take()
	if len(msgs) != 1 || msgs[0].v["t"] != "wave" || msgs[0].v["w"] != 1 {
		t.Fatalf("solo player should start wave 1 at once, got %v", msgs)
	}
	if at := msgs[0].v["at"].(int64); at != now.Add(waveLead).UnixMilli() {
		t.Fatalf("at = %d", at)
	}

	// Player 2 joins mid-wave: catches up with wave 1.
	g.handle(2, clientEvent{T: "kill", W: 1, ID: 5}, now)
	g.handle(1, clientEvent{T: "kill", W: 1, ID: 5}, now)
	g.handle(1, clientEvent{T: "kill", W: 1, ID: 5}, now)
	if msgs := rec.take(); len(msgs) != 1 || msgs[0].except != 1 {
		t.Fatalf("one kill relay expected (non-player ignored, duplicate dropped), got %v", msgs)
	}
	g.handle(2, clientEvent{T: "ready", W: 1}, now)
	msgs = rec.take()
	if len(msgs) != 1 || msgs[0].to != 2 || msgs[0].v["w"] != 1 {
		t.Fatalf("late joiner should get the current wave, got %v", msgs)
	}
	if kills := msgs[0].v["kills"].([]int); len(kills) != 1 || kills[0] != 5 {
		t.Fatalf("kills = %v", kills)
	}

	// Wave 2 needs both.
	g.handle(1, clientEvent{T: "ready", W: 2}, now)
	if msgs := rec.take(); len(msgs) != 0 {
		t.Fatalf("started without player 2: %v", msgs)
	}
	g.handle(2, clientEvent{T: "ready", W: 2}, now.Add(time.Second))
	if msgs := rec.take(); len(msgs) != 1 || msgs[0].v["w"] != 2 {
		t.Fatalf("wave 2 should start, got %v", msgs)
	}
}

func TestReadyTimeoutAndLeaving(t *testing.T) {
	g, rec := newTestGame()
	now := time.UnixMilli(5_000_000)
	g.handle(1, clientEvent{T: "ready", W: 1}, now)
	g.handle(2, clientEvent{T: "ready", W: 1}, now)
	rec.take()

	g.handle(1, clientEvent{T: "ready", W: 2}, now)
	g.tick(now.Add(readyTimeout - time.Millisecond))
	if msgs := rec.take(); len(msgs) != 0 {
		t.Fatalf("started early: %v", msgs)
	}
	g.tick(now.Add(readyTimeout))
	if msgs := rec.take(); len(msgs) != 1 || msgs[0].v["w"] != 2 {
		t.Fatalf("timeout should start wave 2, got %v", msgs)
	}

	// Player 2 game-overs while player 1 waits: wave 3 starts right away.
	g.handle(1, clientEvent{T: "ready", W: 3}, now)
	g.handle(2, clientEvent{T: "out"}, now)
	msgs := rec.take()
	if len(msgs) != 2 || msgs[0].v["t"] != "out" || msgs[1].v["w"] != 3 {
		t.Fatalf("got %v", msgs)
	}

	// Everybody gone: the next player starts over at wave 1.
	g.leave(1, now)
	rec.take()
	g.handle(3, clientEvent{T: "ready", W: 1}, now)
	if msgs := rec.take(); len(msgs) != 1 || msgs[0].v["w"] != 1 {
		t.Fatalf("got %v", msgs)
	}
}

func TestStaleWaveEventsIgnored(t *testing.T) {
	g, rec := newTestGame()
	now := time.UnixMilli(0)
	g.handle(1, clientEvent{T: "ready", W: 1}, now)
	rec.take()
	g.handle(1, clientEvent{T: "dmg", W: 2, H: [][2]float64{{1, 2}}}, now)
	g.handle(1, clientEvent{T: "pick", W: 0, ID: 3}, now)
	if msgs := rec.take(); len(msgs) != 0 {
		t.Fatalf("got %v", msgs)
	}
	g.handle(1, clientEvent{T: "dmg", W: 1, H: [][2]float64{{1, 2}}}, now)
	if msgs := rec.take(); len(msgs) != 1 || msgs[0].v["by"] != uint16(1) {
		t.Fatalf("got %v", msgs)
	}
}

func TestBossStartsOnceForTheSquad(t *testing.T) {
	g, rec := newTestGame()
	now := time.UnixMilli(10_000)
	g.handle(1, clientEvent{T: "ready", W: 1}, now)
	g.handle(2, clientEvent{T: "ready", W: 1}, now)
	if msgs := rec.take(); msgs[0].v["squad"] != 1 {
		t.Fatalf("squad at start = %v", msgs[0].v["squad"])
	}
	g.handle(1, clientEvent{T: "boss", W: 1}, now)
	msgs := rec.take()
	if len(msgs) != 1 || msgs[0].v["t"] != "boss" || msgs[0].except != 0 || msgs[0].v["at"] != now.Add(bossLead).UnixMilli() {
		t.Fatalf("got %v", msgs)
	}
	// The second player gets the same start time, and only they get it.
	g.handle(2, clientEvent{T: "boss", W: 1}, now.Add(time.Second))
	msgs = rec.take()
	if len(msgs) != 1 || msgs[0].to != 2 || msgs[0].v["at"] != now.Add(bossLead).UnixMilli() {
		t.Fatalf("got %v", msgs)
	}
	g.handle(1, clientEvent{T: "boss", W: 7}, now)
	if msgs := rec.take(); len(msgs) != 0 {
		t.Fatalf("stale boss request answered: %v", msgs)
	}
}
