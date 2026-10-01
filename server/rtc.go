package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// A peer that hasn't connected within this time after signalling is dropped.
const connectTimeout = 20 * time.Second

type rtcServer struct {
	api  *webrtc.API
	mux  ice.UDPMux
	room *room
}

// newRTC multiplexes every peer over one UDP port, so only that port needs to be open, and
// advertises the public IP so browsers behind CG-NAT can reach it directly (no STUN/TURN).
func newRTC(cfg config, room *room) (*rtcServer, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: cfg.udpPort})
	if err != nil {
		return nil, err
	}
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})

	var se webrtc.SettingEngine
	se.SetICEUDPMux(mux)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICETimeouts(4*time.Second, 8*time.Second, 2*time.Second)
	// Browsers' host candidates are mDNS names; the server needn't resolve them, since the
	// browser's checks reveal its real (NATed) address anyway.
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	if cfg.publicIP != "" {
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        []string{cfg.publicIP},
			AsCandidateType: webrtc.ICECandidateTypeHost,
		}); err != nil {
			return nil, err
		}
	}
	return &rtcServer{api: webrtc.NewAPI(webrtc.WithSettingEngine(se)), mux: mux, room: room}, nil
}

func (s *rtcServer) close() {
	_ = s.mux.Close()
}

// handleOffer takes the browser's complete SDP offer (non-trickle) and returns the answer
// with the server's single candidate.
func (s *rtcServer) handleOffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST an SDP offer", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Query().Get("v") != strconv.Itoa(protocolVersion) {
		http.Error(w, "game client out of date: reload the page", http.StatusUpgradeRequired)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&offer); err != nil || offer.Type != webrtc.SDPTypeOffer {
		http.Error(w, "bad offer", http.StatusBadRequest)
		return
	}

	pc, err := s.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, "peer connection failed", http.StatusInternalServerError)
		return
	}
	p := s.room.add(pc)
	if p == nil {
		_ = pc.Close()
		http.Error(w, "server full", http.StatusServiceUnavailable)
		return
	}

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.room.remove(p)
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		s.room.setChannel(p, dc)
		switch dc.Label() {
		case "state":
			dc.OnMessage(func(m webrtc.DataChannelMessage) { s.room.updateState(p, m.Data) })
		case "events":
			dc.OnOpen(func() { s.room.join(p) })
			// A browser closing the connection closes its channels right away; quicker than ICE timeouts.
			dc.OnClose(func() { s.room.remove(p) })
			dc.OnMessage(func(m webrtc.DataChannelMessage) { s.room.handleEvent(p, m.Data) })
		}
	})
	time.AfterFunc(connectTimeout, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			s.room.remove(p)
		}
	})

	answer, err := s.answer(pc, offer)
	if err != nil {
		log.Printf("signalling player %d: %v", p.id, err)
		s.room.remove(p)
		http.Error(w, "bad offer", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(answer)
}

func (s *rtcServer) answer(pc *webrtc.PeerConnection, offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	if err := pc.SetRemoteDescription(offer); err != nil {
		return nil, err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return nil, err
	}
	// With a UDP mux there's one local candidate, so gathering is immediate.
	<-gathered
	return pc.LocalDescription(), nil
}
