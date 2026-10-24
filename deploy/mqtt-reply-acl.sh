#!/usr/bin/env bash
# One-time migration of the live mosquitto ACL to per-unit reply topics.
# Run on the droplet as root. Both apps (prod + staging) share this broker.
#
#   bash deploy/mqtt-reply-acl.sh status          # what the file looks like now
#   bash deploy/mqtt-reply-acl.sh add             # step 1: add the pattern line, keep the legacy lines, reload
#   bash deploy/mqtt-reply-acl.sh probe <mac>     # round-trip an RPC on the NEW reply topic with an online unit
#   bash deploy/mqtt-reply-acl.sh finalize --yes  # step 3: drop the legacy shared-topic lines, reload
#   bash deploy/mqtt-reply-acl.sh rollback        # put the legacy line back in every unit block, reload
#
# Order: add → deploy staging → probe a 1.3.x and a 2.0.x unit (a slash inside
# the Shelly `src` has not been exercised on real firmware before this rollout)
# → deploy production → finalize --yes. Between add and finalize both reply
# topics work, so either server build is fine. finalize refuses unless the
# production tree is a build that sends the new src (FORCE=1 overrides).
# Rollback after finalize = this script's rollback + the previous server build.
set -euo pipefail
ACL=${ACL_FILE:-/etc/mosquitto/acl}
PROD_DIR=${PROD_DIR:-/opt/shabat_clock}
PATTERN='pattern write shabat-server/%u/rpc'
LEGACY='topic write shabat-server/rpc'
MODE=${1:-status}

count() { grep -c -E "$1" "$ACL" || true; }
show() {
  echo "ACL file: $ACL"
  echo "  unit blocks            : $(count '^user shelly-')"
  echo "  legacy shared lines    : $(count '^topic write shabat-server/(rpc|#)$')"
  echo "  per-unit pattern line  : $(count "^${PATTERN}$")"
}
backup() { cp -a "$ACL" "$ACL.bak-$(date +%Y%m%d-%H%M%S)"; }
# Replace the ACL with a freshly written file, keeping owner and mode.
install_new() {
  chown --reference="$ACL" "$ACL.new" 2>/dev/null || true
  chmod --reference="$ACL" "$ACL.new" 2>/dev/null || true
  mv "$ACL.new" "$ACL"
}
reload() {
  # There is no offline ACL checker. Reload, then read what the broker said
  # about it: a malformed file leaves an error in the journal and may leave the
  # broker running with a broken security set — that must not pass silently.
  local since; since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl reload mosquitto
  sleep 2
  if ! systemctl is-active --quiet mosquitto; then echo "mosquitto NOT active"; exit 1; fi
  local errs
  errs=$(journalctl -u mosquitto --since "$since" --no-pager 2>/dev/null | grep -iE 'error|unable|invalid' || true)
  if [ -n "$errs" ]; then
    echo "mosquitto reported a problem on reload:"; echo "$errs"
    echo "RESTORE the latest $ACL.bak-* and reload before anything else."; exit 1
  fi
  echo "mosquitto reloaded, active, no errors in its journal"
}
# Ask one unit for its device info with the NEW src and wait for the answer on
# its per-unit topic. Needs the app's broker credentials (prod .env).
probe() {
  local mac=${1:-}; [ -n "$mac" ] || { echo "usage: $0 probe <mac>"; exit 2; }
  set -a; . <(grep -E '^MQTT_SERVER_(USER|PASS)=' "$PROD_DIR/.env"); set +a
  local topic="shabat-server/shelly-$mac/rpc" out; out=$(mktemp)
  ( timeout 10 mosquitto_sub -h localhost -p 1883 -u "$MQTT_SERVER_USER" -P "$MQTT_SERVER_PASS" -t "$topic" -C 1 > "$out" 2>&1 & )
  sleep 1
  mosquitto_pub -h localhost -p 1883 -u "$MQTT_SERVER_USER" -P "$MQTT_SERVER_PASS" -t "shellypro2-$mac/rpc" \
    -m "{\"id\":$((RANDOM * 32768 + RANDOM)),\"src\":\"shabat-server/shelly-$mac\",\"method\":\"Shelly.GetDeviceInfo\"}"
  sleep 8
  if grep -q '"result"' "$out"; then
    echo "OK — $mac answered on $topic: $(grep -oE '"(model|ver)":"[^"]+"' "$out" | tr '\n' ' ')"
  else
    echo "NO ANSWER on $topic within 8 s (unit offline, or its reply was denied by the ACL)"; rm -f "$out"; exit 1
  fi
  rm -f "$out"
}

case "$MODE" in
  status) show ;;
  add)
    backup
    if grep -q -E "^${PATTERN}$" "$ACL"; then
      echo "pattern line already present"
    else
      # Next to the server block at the top — pattern lines are global wherever
      # they sit, but a reader looks for them there.
      printf '%s\n\n' "$PATTERN" | cat - "$ACL" > "$ACL.new"; install_new
      echo "pattern line added"
    fi
    show; reload ;;
  probe) probe "${2:-}" ;;
  finalize)
    [ "${2:-}" = "--yes" ] || { echo "finalize strips the legacy line from EVERY unit block; run it as: $0 finalize --yes"; exit 2; }
    grep -q -E "^${PATTERN}$" "$ACL" || { echo "refusing: pattern line missing — run add first"; exit 1; }
    if [ "${FORCE:-0}" != "1" ]; then
      # The production build must already send the new src, or every RPC it
      # makes will time out the moment the legacy lines are gone.
      grep -q 'replySrcFor' "$PROD_DIR/src/mqtt/reply-src.js" 2>/dev/null \
        || { echo "refusing: $PROD_DIR is not on a build with per-unit reply topics (deploy production first; FORCE=1 overrides)"; exit 1; }
      running=$(curl -s --max-time 5 http://127.0.0.1:3001/healthz | grep -oE '"version":"[0-9a-f]+"' | cut -d'"' -f4 || true)
      tree=$(git -C "$PROD_DIR" rev-parse --short HEAD 2>/dev/null || true)
      [ -n "$running" ] && [ -n "$tree" ] && [ "$running" = "$tree" ] \
        || { echo "refusing: production runs '$running' but the tree is '$tree' — finish the deploy first (FORCE=1 overrides)"; exit 1; }
    fi
    backup
    sed -i -E '/^topic write shabat-server\/(rpc|#)$/d' "$ACL"
    echo "legacy lines removed"
    show; reload ;;
  rollback)
    backup
    # State machine over unit blocks: a block that reaches its end (blank line,
    # next user, or EOF) without a legacy line gets one.
    awk -v legacy="$LEGACY" '
      function flush() { if (inunit && !has) print legacy; inunit = 0; has = 0 }
      /^user shelly-/            { flush(); inunit = 1; print; next }
      /^user /                   { flush(); print; next }
      /^topic write shabat-server\// { has = 1; print; next }
      /^[[:space:]]*$/           { flush(); print; next }
      { print }
      END { flush() }
    ' "$ACL" > "$ACL.new"; install_new
    echo "legacy lines restored"
    show; reload ;;
  *) echo "usage: $0 status|add|probe <mac>|finalize --yes|rollback"; exit 2 ;;
esac
