#!/bin/sh
# Obtains the certificate once via the Cloudflare DNS challenge, then tries renewal twice a day.
set -e
: "${DOMAIN:?}" "${EMAIL:?}" "${CLOUDFLARE_API_TOKEN:?}"

credentials=/etc/letsencrypt/cloudflare.ini
umask 077
printf 'dns_cloudflare_api_token = %s\n' "$CLOUDFLARE_API_TOKEN" > "$credentials"

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  staging=""
  [ "${CERTBOT_STAGING:-0}" = "1" ] && staging="--staging"
  certbot certonly --non-interactive --agree-tos -m "$EMAIL" \
    --dns-cloudflare --dns-cloudflare-credentials "$credentials" \
    --dns-cloudflare-propagation-seconds 30 \
    -d "$DOMAIN" $staging
fi

while :; do
  certbot renew --quiet || echo "renewal attempt failed; will retry"
  sleep 12h
done
