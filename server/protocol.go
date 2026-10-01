package main

import (
	"encoding/binary"
	"math"
)

// Binary messages on the unreliable "state" channel (little-endian).
//
// Client → server, msgPlayerState (18 bytes):
//
//	u8 type | f32 x | f32 y | u8 flags | u8 gun | u8 gunLevel | u8 rocketLevel | u8 wave | u32 time
//
// x is -1..1 across the shared arena and y is world y over the arena's half height (about -1..1).
// time is the low 32 bits of the sender's estimate of server time (Unix ms) when it sent the
// state; enemies aim from these timed samples, so every client aims the same shots.
//
// Server → client, msgSnapshot:
//
//	u8 type | u16 count | count × (u16 id | the 13 state bytes above)
//
// JSON messages on the reliable "events" channel:
//
//	server → client: {"t":"welcome","id":1,"players":[2,3],"v":2} {"t":"join","id":4} {"t":"leave","id":2}
//	                 {"t":"pong","c":<client ms>,"s":<server ms>}
//	                 {"t":"wave","w":3,"seed":<u32>,"at":<server ms>,"squad":2,"kills":[ids],"picks":[ids]}
//	                 {"t":"boss","w":4,"at":<server ms>} (the base fight starts for everyone)
//	                 {"t":"kill"|"pick","w":3,"id":17,"by":2} {"t":"dmg","w":3,"by":2,"h":[[id,damage],…]}
//	                 {"t":"out","id":2,"quit":false} (game over; quit: disconnected)
//	client → server: {"t":"ping","c":<client ms>}
//	                 {"t":"ready","w":<wave wanted>} {"t":"out"} (game over)
//	                 {"t":"kill"|"pick","w":3,"id":17} {"t":"dmg","w":3,"h":[[id,damage],…]}
//	                 {"t":"boss","w":4} (this client reached the base)
//
// Clients put ?v=<protocolVersion> on the offer URL; others get 426 Upgrade Required.
const (
	protocolVersion = 2

	msgPlayerState = 1
	msgSnapshot    = 2

	stateBytes  = 17
	playerBytes = 2 + stateBytes
)

// playerState is kept as the raw wire bytes: the server only relays it.
type playerState [stateBytes]byte

func decodePlayerState(b []byte) (playerState, bool) {
	var s playerState
	if len(b) < 1+stateBytes || b[0] != msgPlayerState {
		return s, false
	}
	copy(s[:], b[1:1+stateBytes])
	x := math.Float32frombits(binary.LittleEndian.Uint32(s[0:4]))
	y := math.Float32frombits(binary.LittleEndian.Uint32(s[4:8]))
	if !finite(x) || !finite(y) {
		return s, false
	}
	return s, true
}

func finite(f float32) bool {
	return !math.IsNaN(float64(f)) && !math.IsInf(float64(f), 0)
}

type idState struct {
	id    uint16
	state playerState
}

func encodeSnapshot(buf []byte, players []idState) []byte {
	buf = append(buf[:0], msgSnapshot, 0, 0)
	binary.LittleEndian.PutUint16(buf[1:3], uint16(len(players)))
	for _, p := range players {
		buf = binary.LittleEndian.AppendUint16(buf, p.id)
		buf = append(buf, p.state[:]...)
	}
	return buf
}
