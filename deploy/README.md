# Co-op server deployment

Three containers (see `docker-compose.yml`):

- **game**: the Go server (`../server`, Pion WebRTC). Every browser connects to one UDP port
  that is published directly, so game traffic doesn't pass through any proxy.
- **proxy**: nginx terminating TLS for the HTTPS signalling endpoint (`/rtc/offer`) only.
- **certbot**: gets and renews a Let's Encrypt certificate with the Cloudflare DNS challenge,
  so ports 80 and 443 aren't touched.

Default ports: **7443/tcp** (signalling) and **47100/udp** (WebRTC). Both are set in `.env`.

## Setup

1. DNS: add an `A` record such as `coop.example.com` pointing at the VPS. Set it to
   **DNS only** (grey cloud): the UDP traffic goes straight to the IP, and Cloudflare
   doesn't proxy port 7443.
2. Cloudflare API token: create one with *Zone → DNS → Edit* on that zone.
3. Firewall: open 7443/tcp and 47100/udp.
4. `cp .env.example .env` and fill it in (`DOMAIN`, `PUBLIC_IP`, `EMAIL`, `CLOUDFLARE_API_TOKEN`).
   While trying things out, `CERTBOT_STAGING=1` avoids Let's Encrypt rate limits. Delete the
   `letsencrypt` volume before switching to real certificates.
5. `docker compose up -d --build`, then `docker compose logs -f`. The proxy waits until
   the certificate exists. To check: `curl https://coop.example.com:7443/healthz`.

## Playing

Open the game with `?coop=https://coop.example.com:7443` once (it's remembered), or press
*Co-op* in the pause menu and enter the address. For a build that connects by default, set
`VITE_COOP_SERVER` when building the client.

Every connected player shares one instance for now: you see each other's ships, guns and
fire, but each player's enemies are still their own.

## Running the server without Docker

```sh
cd server
PUBLIC_IP=203.0.113.10 RTC_UDP_PORT=47100 HTTP_ADDR=:8080 go run .
```

`PUBLIC_IP` can be left out for local testing (browser and server on the same machine or LAN).
