package main

import (
	"encoding/binary"
	"math"
)

// Binary messages on the unreliable "state" channel (little-endian).
//
// Client → server, msgPlayerState (14 bytes):
//
//	u8 type | f32 x | f32 y | u8 flags | u8 gun | u8 gunLevel | u8 rocketLevel | u8 wave
//
// x is -1..1 across the playfield and y 0..1 from its bottom, so screens of any aspect agree.
//
// Server → client, msgSnapshot:
//
//	u8 type | u16 count | count × (u16 id | the 13 state bytes above)
//
// JSON messages on the reliable "events" channel:
//
//	server → client: {"t":"welcome","id":1,"players":[2,3]} {"t":"join","id":4} {"t":"leave","id":2}
//	                 {"t":"pong","c":<client ms>,"s":<server ms>}
//	client → server: {"t":"ping","c":<client ms>}
const (
	msgPlayerState = 1
	msgSnapshot    = 2

	stateBytes  = 13
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
