package main

import (
	"encoding/binary"
	"math"
	"testing"
)

func stateMsg(x, y float32, flags byte) []byte {
	b := []byte{msgPlayerState}
	b = binary.LittleEndian.AppendUint32(b, math.Float32bits(x))
	b = binary.LittleEndian.AppendUint32(b, math.Float32bits(y))
	return append(b, flags, 1, 3, 2, 7)
}

func TestPlayerStateRoundTrip(t *testing.T) {
	s, ok := decodePlayerState(stateMsg(-0.5, 0.25, 3))
	if !ok {
		t.Fatal("valid state rejected")
	}
	snap := encodeSnapshot(nil, []idState{{id: 42, state: s}})
	if len(snap) != 3+playerBytes || snap[0] != msgSnapshot || binary.LittleEndian.Uint16(snap[1:3]) != 1 {
		t.Fatalf("bad snapshot header: %v", snap)
	}
	if id := binary.LittleEndian.Uint16(snap[3:5]); id != 42 {
		t.Fatalf("id = %d", id)
	}
	if x := math.Float32frombits(binary.LittleEndian.Uint32(snap[5:9])); x != -0.5 {
		t.Fatalf("x = %v", x)
	}
	if wave := snap[len(snap)-1]; wave != 7 {
		t.Fatalf("wave = %d", wave)
	}
}

func TestPlayerStateRejectsGarbage(t *testing.T) {
	if _, ok := decodePlayerState([]byte{msgPlayerState, 1, 2}); ok {
		t.Error("short message accepted")
	}
	if _, ok := decodePlayerState(stateMsg(float32(math.NaN()), 0, 0)); ok {
		t.Error("NaN accepted")
	}
	bad := stateMsg(0, 0, 0)
	bad[0] = msgSnapshot
	if _, ok := decodePlayerState(bad); ok {
		t.Error("wrong type accepted")
	}
}
