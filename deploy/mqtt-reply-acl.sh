#!/usr/bin/env bash
# One-time migration of the live mosquitto ACL to per-unit reply topics.
# Run on the droplet as root. Both apps (prod + staging) share this broker.
#
#   bash deploy/mqtt-reply-acl.sh status    # what the file looks like now
#   bash deploy/mqtt-reply-acl.sh add       # step 1: add the pattern line, keep the legacy lines, reload
#   bash deploy/mqtt-reply-acl.sh finalize  # step 3: drop the legacy shared-topic lines, reload
#   bash deploy/mqtt-reply-acl.sh rollback  # put the legacy line back in every unit block, reload
#
# Order: add → deploy the servers (src = shabat-server/shelly-<mac>, see
# src/mqtt/reply-src.js) → verify RPCs answer → finalize. Between add and
# finalize both the old and the new reply topic work, so either server version
# is fine. Rollback after finalize = this script's rollback + the previous
# server build (the old src writes the shared topic again).
set -euo pipefail
ACL=${ACL_FILE:-/etc/mosquitto/acl}
PATTERN='pattern write shabat-server/%u/rpc'
MODE=${1:-status}

count() { grep -c -E "$1" "$ACL" || true; }
show() {
  echo "ACL file: $ACL"
  echo "  unit blocks            : $(count '^user shelly-')"
  echo "  legacy shared lines    : $(count '^topic write shabat-server/(rpc|#)$')"
  echo "  per-unit pattern line  : $(count "^${PATTERN}$")"
}
reload() {
  # A syntax slip in the ACL would stop the broker from reloading cleanly —
  # check first, then reload, then prove the broker is still up.
  mosquitto -c /etc/mosquitto/mosquitto.conf -t 2>/dev/null || true
  systemctl reload mosquitto
  sleep 1
  systemctl is-active --quiet mosquitto && echo "mosquitto reloaded, active" || { echo "mosquitto NOT active"; exit 1; }
}

case "$MODE" in
  status) show ;;
  add)
    cp -a "$ACL" "$ACL.bak-$(date +%Y%m%d-%H%M%S)"
    if grep -q -E "^${PATTERN}$" "$ACL"; then
      echo "pattern line already present"
    else
      # Keep it next to the server block at the top — pattern lines are global
      # wherever they sit, but a reader looks for them there.
      printf '%s\n\n' "$PATTERN" | cat - "$ACL" > "$ACL.new" && mv "$ACL.new" "$ACL"
      chown mosquitto:mosquitto "$ACL" 2>/dev/null || true
      echo "pattern line added"
    fi
    show; reload ;;
  finalize)
    grep -q -E "^${PATTERN}$" "$ACL" || { echo "refusing: pattern line missing — run add first"; exit 1; }
    cp -a "$ACL" "$ACL.bak-$(date +%Y%m%d-%H%M%S)"
    sed -i -E '/^topic write shabat-server\/(rpc|#)$/d' "$ACL"
    echo "legacy lines removed"
    show; reload ;;
  rollback)
    cp -a "$ACL" "$ACL.bak-$(date +%Y%m%d-%H%M%S)"
    # Re-add the shared line right after every unit's readwrite line that lacks one.
    awk '
      /^user shelly-/ { inunit=1 }
      /^user / && !/^user shelly-/ { inunit=0 }
      { print }
      inunit && /^topic readwrite shellypro2-/ { getline nxt; if (nxt !~ /^topic write shabat-server\//) print "topic write shabat-server/rpc"; print nxt }
    ' "$ACL" > "$ACL.new" && mv "$ACL.new" "$ACL"
    chown mosquitto:mosquitto "$ACL" 2>/dev/null || true
    echo "legacy lines restored"
    show; reload ;;
  *) echo "usage: $0 status|add|finalize|rollback"; exit 2 ;;
esac
