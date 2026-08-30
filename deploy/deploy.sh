#!/usr/bin/env bash
# Deploys shabat_clock on the droplet — manually: bash deploy/deploy.sh
# Assumes the one-time setup in deploy/SERVER-SETUP.md was done (clone, .env, pm2).
#
# Production (defaults):  /opt/shabat_clock, branch master, pm2 shabat-clock, :3001
# Staging (dev branch):   BRANCH=dev APP_DIR=/opt/shabat_clock-dev PM2_NAME=shabat-clock-dev PORT=3002 bash deploy/deploy.sh
#   → https://dev.kosher-teltech.com — same droplet, same DB (by user decision), NODE_ENV=staging
#     so the health monitor stays passive and Shelly schedule pushes are skipped (see ecosystem.config.cjs).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/shabat_clock}"
BRANCH="${BRANCH:-master}"
PM2_NAME="${PM2_NAME:-shabat-clock}"
PORT="${PORT:-3001}"
cd "$APP_DIR"

echo "==> Pulling latest $BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Installing server dependencies"
npm ci --omit=dev

echo "==> Building web panel"
npm run build:web

echo "==> Running DB migrations (against DATABASE_URL from .env)"
npm run migrate

echo "==> Reloading $PM2_NAME via PM2"
pm2 startOrReload ecosystem.config.cjs --only "$PM2_NAME" --update-env
pm2 save

echo "==> Health check"
sleep 2
curl -fsS "http://localhost:$PORT/healthz" && echo " — OK"
