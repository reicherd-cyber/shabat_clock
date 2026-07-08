#!/usr/bin/env bash
# Deploys shabat_clock on the droplet. Invoked by GitHub Actions after every push
# to master (see .github/workflows/deploy.yml), or manually: bash deploy/deploy.sh
# Assumes the one-time setup in deploy/SERVER-SETUP.md was done (clone, .env, pm2).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/shabat_clock}"
cd "$APP_DIR"

echo "==> Pulling latest master"
git fetch origin master
git reset --hard origin/master

echo "==> Installing server dependencies"
npm ci --omit=dev

echo "==> Building web panel"
npm run build:web

echo "==> Running DB migrations (against DATABASE_URL from .env)"
npm run migrate

echo "==> Reloading app via PM2"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo "==> Health check"
sleep 2
curl -fsS http://localhost:3001/healthz && echo " — OK"
