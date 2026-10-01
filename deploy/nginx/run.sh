#!/bin/sh
# Waits for the first certificate, reloads periodically to pick up renewals, then runs nginx.
set -e
cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
until [ -f "$cert" ]; do
  echo "waiting for certificate $cert"
  sleep 5
done
(while :; do sleep 6h; nginx -s reload; done) &
exec /docker-entrypoint.sh nginx -g 'daemon off;'
