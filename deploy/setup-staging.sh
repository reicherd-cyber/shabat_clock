#!/usr/bin/env bash
# One-time (idempotent) setup of the STAGING instance on the production droplet:
# the dev branch, deployed exactly like production — its own checkout, pm2 app,
# nginx site and certificate — at https://dev.kosher-teltech.com.
#
#   ssh root@<droplet> 'bash -s' < deploy/setup-staging.sh
#   (or on the droplet: bash /opt/shabat_clock/deploy/setup-staging.sh)
#
# Re-running is safe: every step checks before acting. Later deploys of dev:
#   BRANCH=dev APP_DIR=/opt/shabat_clock-dev PM2_NAME=shabat-clock-dev PORT=3002 bash deploy/deploy.sh
#
# Shares the production DB by user decision (2026-07-17). NODE_ENV=staging (from
# ecosystem.config.cjs) keeps the health monitor passive and skips Shelly schedule
# pushes, so the two servers never both act on the device fleet.
set -euo pipefail

PROD_DIR=/opt/shabat_clock
APP_DIR=/opt/shabat_clock-dev
DOMAIN=dev.kosher-teltech.com
PORT=3002
REPO=https://github.com/reicherd-cyber/shabat_clock

echo "==> Checkout ($APP_DIR, branch dev)"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -b dev "$REPO" "$APP_DIR"
fi

echo "==> .env (copied from production, PORT=$PORT)"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$PROD_DIR/.env" "$APP_DIR/.env"
  if grep -q '^PORT=' "$APP_DIR/.env"; then
    sed -i "s/^PORT=.*/PORT=$PORT/" "$APP_DIR/.env"
  else
    echo "PORT=$PORT" >> "$APP_DIR/.env"
  fi
fi

echo "==> nginx site ($DOMAIN → :$PORT)"
if [ ! -f /etc/nginx/sites-available/shabat-clock-dev ]; then
  cat > /etc/nginx/sites-available/shabat-clock-dev <<EOF
# Staging: the dev branch of shabat_clock, deployed like production (pm2 shabat-clock-dev, :$PORT)
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
fi
ln -sf /etc/nginx/sites-available/shabat-clock-dev /etc/nginx/sites-enabled/shabat-clock-dev
nginx -t && systemctl reload nginx

echo "==> Deploy dev (npm ci, build, migrate, pm2)"
BRANCH=dev APP_DIR="$APP_DIR" PM2_NAME=shabat-clock-dev PORT=$PORT bash "$APP_DIR/deploy/deploy.sh"

echo "==> Certificate"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "already issued"
elif getent hosts "$DOMAIN" >/dev/null; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring \
    || echo "!! certbot failed — check that the DNS record for $DOMAIN points here, then rerun this script"
else
  echo "!! $DOMAIN does not resolve yet — add the DNS record (A → this droplet, Cloudflare proxied is fine) and rerun this script for HTTPS"
fi

echo "==> Done: http(s)://$DOMAIN"
