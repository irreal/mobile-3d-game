package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Skip snapshots to a peer whose unreliable channel is backed up; they'd only arrive stale.
const maxBufferedSnapshot = 64 * 1024

type player struct {
	id       uint16
	pc       *webrtc.PeerConnection
	state    *webrtc.DataChannel
	events   *webrtc.DataChannel
	joined   bool
	hasState bool
	last     playerState
}

// room is the single shared game instance: it relays every player's ship state to the others
// and runs the shared game.
type room struct {
	mu         sync.Mutex
	players    map[uint16]*player
	nextID     uint16
	maxPlayers int
	game       *game
}

func newRoom(maxPlayers int) *room {
	r := &room{players: map[uint16]*player{}, maxPlayers: maxPlayers}
	r.game = newGame(r)
	return r
}

func (r *room) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.players)
}

// add reserves a slot for a new peer, or returns nil when the room is full.
func (r *room) add(pc *webrtc.PeerConnection) *player {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.players) >= r.maxPlayers {
		return nil
	}
	for {
		r.nextID++
		if _, taken := r.players[r.nextID]; r.nextID != 0 && !taken {
			break
		}
	}
	p := &player{id: r.nextID, pc: pc}
	r.players[p.id] = p
	return p
}

func (r *room) remove(p *player) {
	r.mu.Lock()
	_, present := r.players[p.id]
	delete(r.players, p.id)
	wasJoined := p.joined
	r.mu.Unlock()
	if !present {
		return
	}
	_ = p.pc.Close()
	r.game.leave(p.id, time.Now())
	if wasJoined {
		log.Printf("player %d left (%d online)", p.id, r.count())
		r.broadcastEvent(map[string]any{"t": "leave", "id": p.id}, p.id)
	}
}

func (r *room) setChannel(p *player, dc *webrtc.DataChannel) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch dc.Label() {
	case "state":
		p.state = dc
	case "events":
		p.events = dc
	}
}

// join announces a player once its reliable channel is open.
func (r *room) join(p *player) {
	r.mu.Lock()
	if _, present := r.players[p.id]; !present {
		r.mu.Unlock()
		return
	}
	p.joined = true
	others := make([]uint16, 0, len(r.players))
	for id, o := range r.players {
		if id != p.id && o.joined {
			others = append(others, id)
		}
	}
	online := len(r.players)
	r.mu.Unlock()

	log.Printf("player %d joined (%d online)", p.id, online)
	sendEvent(p, map[string]any{"t": "welcome", "id": p.id, "players": others, "v": protocolVersion})
	r.broadcastEvent(map[string]any{"t": "join", "id": p.id}, p.id)
}

func (r *room) updateState(p *player, msg []byte) {
	s, ok := decodePlayerState(msg)
	if !ok {
		return
	}
	r.mu.Lock()
	p.last = s
	p.hasState = true
	r.mu.Unlock()
}

func (r *room) handleEvent(p *player, msg []byte) {
	var e clientEvent
	if json.Unmarshal(msg, &e) != nil {
		return
	}
	if e.T == "ping" {
		sendEvent(p, map[string]any{"t": "pong", "c": e.C, "s": time.Now().UnixMilli()})
		return
	}
	r.game.handle(p.id, e, time.Now())
}

// send delivers an event to one player (for the game).
func (r *room) send(id uint16, v any) {
	r.mu.Lock()
	p := r.players[id]
	r.mu.Unlock()
	if p != nil && p.joined {
		sendEvent(p, v)
	}
}

func (r *room) broadcast(v any, except uint16) {
	r.broadcastEvent(v, except)
}

func (r *room) broadcastEvent(v any, except uint16) {
	r.mu.Lock()
	targets := make([]*player, 0, len(r.players))
	for id, p := range r.players {
		if id != except && p.joined {
			targets = append(targets, p)
		}
	}
	r.mu.Unlock()
	for _, p := range targets {
		sendEvent(p, v)
	}
}

func sendEvent(p *player, v any) {
	if p.events == nil || p.events.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = p.events.SendText(string(b))
}

// run sends every player a snapshot of all ships at a fixed rate.
func (r *room) run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var states []idState
	var targets []*webrtc.DataChannel
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		r.game.tick(time.Now())
		states = states[:0]
		targets = targets[:0]
		r.mu.Lock()
		for id, p := range r.players {
			if p.hasState {
				states = append(states, idState{id: id, state: p.last})
			}
			if p.joined && p.state != nil {
				targets = append(targets, p.state)
			}
		}
		r.mu.Unlock()
		// Nobody to show anybody else yet.
		if len(states) == 0 || len(targets) < 2 {
			continue
		}
		// A fresh buffer per tick: channels may still hold the previous one.
		snapshot := encodeSnapshot(make([]byte, 0, 3+len(states)*playerBytes), states)
		for _, dc := range targets {
			if dc.ReadyState() == webrtc.DataChannelStateOpen && dc.BufferedAmount() < maxBufferedSnapshot {
				_ = dc.Send(snapshot)
			}
		}
	}
}
