# Co-op server deployment

Three containers (see `docker-compose.yml`):

- **game**: the Go server (`../server`, Pion WebRTC). Every browser connects to one UDP port
  that is published directly, so game traffic doesn't pass through any proxy.
- **proxy**: nginx terminating TLS for the HTTPS signalling endpoint (`/rtc/offer`) only.
- **certbot**: gets and renews a Let's Encrypt certificate with the Cloudflare DNS challenge,
  so ports 80 and 443 aren't touched.

Default ports: **7443/tcp** (signalling) and **47100/udp** (WebRTC). Both are set in `.env`.

## Setup

1. DNS: add an `A` record for `novastrike.irreal.dev` pointing at the VPS. Set it to
   **DNS only** (grey cloud): the UDP traffic goes straight to the IP, and Cloudflare
   doesn't proxy port 7443.
2. Cloudflare API token: create one with *Zone → DNS → Edit* on that zone.
3. Firewall: open 7443/tcp and 47100/udp.
4. `cp .env.example .env` and fill it in (`DOMAIN`, `PUBLIC_IP`, `EMAIL`, `CLOUDFLARE_API_TOKEN`).
   While trying things out, `CERTBOT_STAGING=1` avoids Let's Encrypt rate limits. Delete the
   `letsencrypt` volume before switching to real certificates.
5. `docker compose up -d --build`, then `docker compose logs -f`. The proxy waits until
   the certificate exists. To check: `curl https://novastrike.irreal.dev:7443/healthz`.

## Playing

Press *Co-op* in the pause menu; the game connects to `https://novastrike.irreal.dev:7443` by
default and reconnects to it on later visits. To use another server, open the game once with
`?coop=https://host:port` (remembered) or set `VITE_COOP_SERVER` when building the client.

Every connected player shares one run. The server starts each wave for the whole squad
once everyone is ready, or 20 s after the first player is. It sends a seed and a start time,
and every client simulates the same enemies in step with the server clock. That includes
their fire: each enemy's fire timing is seeded, and aimed shots go at a squad member's
position from 250 ms earlier, using the timestamped ship states every client receives. When
someone reaches a planet's alien base, the server sets one start time for the base fight.
More players get more power-orb carriers (the heavies), in proportion to the squad size at
the start of the wave. Damage, kills and power-orb pickups are shared, and the server makes
sure each kill or pickup counts once. Scores and lives are personal. A player who joins
mid-wave, or comes back from the pause menu, fast-forwards to where the squad is. In co-op the
arena is the narrowest width any screen shows.

Redeploy the game container after updating: the client and server must speak the same
protocol. The client sends its protocol version when connecting. A mismatched server answers
426, and a mismatched client sees "game out of date: reload" or "server out of date".

## Running the server without Docker

```sh
cd server
PUBLIC_IP=203.0.113.10 RTC_UDP_PORT=47100 HTTP_ADDR=:8080 go run .
```

`PUBLIC_IP` can be left out for local testing (browser and server on the same machine or LAN).
