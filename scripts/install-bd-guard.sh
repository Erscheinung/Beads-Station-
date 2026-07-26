#!/bin/bash
# install-bd-guard.sh — reproducible installer for the bd spawn-storm guard.
#
# WHY THIS EXISTS
# --------------
# `bd` is a ~130MB Go binary; each cold invoke costs ~154MB RSS. When many
# agents/shells (e.g. cmux panes) fire bd concurrently and stall on the Dolt
# lock, hundreds stack up and exhaust RAM — a real incident on 2026-07-26
# consumed ~80GB and crashed the host. (Beads-Station itself is immune: it
# uses embedded in-process Dolt and never spawns bd per DB op. The storm came
# from CLI fanout outside the app.)
#
# WHAT THIS INSTALLS (all idempotent — safe to re-run)
#   1. A lockf-semaphore wrapper at $BIN/bd that caps concurrent real-bd
#      processes at BD_MAX_CONCURRENCY (default 4). The real binary is moved
#      to $BIN/bd.real. Excess callers QUEUE; they never run unguarded.
#   2. bdkill / bdcount aliases appended to ~/.zshrc (between marker lines).
#   3. A LaunchAgent (macOS) that kills bd.real if the count ever exceeds 20.
#
# USAGE
#   scripts/install-bd-guard.sh            # install / repair
#   scripts/install-bd-guard.sh --uninstall
#   BD_MAX_CONCURRENCY=6 scripts/install-bd-guard.sh
#
# Escape hatch after install:  BD_NO_GUARD=1 bd ...

set -euo pipefail

BIN="${BD_GUARD_BIN_DIR:-$HOME/.local/bin}"
ZSHRC="$HOME/.zshrc"
PLIST="$HOME/Library/LaunchAgents/com.bd-guard.watchdog.plist"
WATCHDOG="$BIN/bd-watchdog.sh"
MARK_BEGIN="# >>> bd-guard aliases >>>"
MARK_END="# <<< bd-guard aliases <<<"
LABEL="com.bd-guard.watchdog"

log() { printf '  %s\n' "$*"; }

uninstall() {
  echo "Uninstalling bd-guard…"
  # Restore real binary.
  if [ -f "$BIN/bd.real" ]; then
    mv -f "$BIN/bd.real" "$BIN/bd"
    log "restored $BIN/bd from bd.real"
  fi
  rm -f "$WATCHDOG"
  # Remove alias block from zshrc.
  if [ -f "$ZSHRC" ] && grep -qF "$MARK_BEGIN" "$ZSHRC"; then
    # Delete the marked block (portable sed via temp file).
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
      $0==b{skip=1} !skip{print} $0==e{skip=0}' "$ZSHRC" > "$ZSHRC.tmp"
    mv -f "$ZSHRC.tmp" "$ZSHRC"
    log "removed alias block from $ZSHRC"
  fi
  # Unload + remove LaunchAgent (macOS only).
  if [ "$(uname)" = "Darwin" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    log "unloaded + removed $PLIST"
  fi
  echo "Done. New shells run bd unguarded again."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

MAX="${BD_MAX_CONCURRENCY:-4}"
mkdir -p "$BIN"

# ---- locate the real bd -------------------------------------------------
# Idempotent: if bd.real already exists we assume a prior install and reuse
# it. Otherwise find the current bd on PATH (must NOT already be our wrapper).
if [ -f "$BIN/bd.real" ]; then
  log "bd.real already present — reusing"
else
  CUR="$(command -v bd || true)"
  if [ -z "$CUR" ]; then
    echo "ERROR: no 'bd' found on PATH and no $BIN/bd.real. Install bd first." >&2
    exit 1
  fi
  # Guard against wrapping our own wrapper.
  if head -3 "$CUR" 2>/dev/null | grep -q "bd concurrency guard"; then
    echo "ERROR: 'bd' on PATH is already the guard wrapper but bd.real is missing." >&2
    echo "       Reinstall bd, or restore bd.real manually." >&2
    exit 1
  fi
  # Ensure the wrapper we write will shadow the real one: real must live at
  # $BIN. If bd resolves elsewhere, copy it in as bd.real.
  if [ "$CUR" = "$BIN/bd" ]; then
    mv -f "$CUR" "$BIN/bd.real"
  else
    cp -f "$CUR" "$BIN/bd.real"
    log "copied $CUR -> $BIN/bd.real (ensure $BIN precedes its dir on PATH)"
  fi
  log "real binary secured at $BIN/bd.real"
fi

# ---- 1. write the wrapper ----------------------------------------------
cat > "$BIN/bd" <<'WRAPPER'
#!/bin/bash
# bd concurrency guard (installed by scripts/install-bd-guard.sh).
# Real binary is bd.real (~130MB, ~154MB RSS per invoke). This caps concurrent
# real-bd at BD_MAX_CONCURRENCY by routing each call through a lockf slot and
# BLOCKING (queuing) when the slot is busy. Transparent: same argv, stdio, and
# exit code. Bypass with BD_NO_GUARD=1.

REAL="${0}.real"
[ -x "$REAL" ] || REAL="$(dirname "$0")/bd.real"

if [ "${BD_NO_GUARD:-0}" = "1" ] || [ ! -x "$REAL" ]; then
  exec "$REAL" "$@"
fi

MAX="${BD_MAX_CONCURRENCY:-4}"
LOCKDIR="${TMPDIR:-/tmp}/bd-guard-slots"
mkdir -p "$LOCKDIR" 2>/dev/null || true

# Deterministic slot; blocking wait so excess callers QUEUE rather than run
# unguarded. lockf holds the lock for bd.real's whole lifetime, so at most
# MAX real-bd run at once. 120s budget prevents a true deadlock.
SLOT="$LOCKDIR/slot.$(( $$ % MAX ))"
if /usr/bin/lockf -s -t 120 "$SLOT" "$REAL" "$@"; then
  exit 0
else
  rc=$?
  # rc 75 == lockf timed out (pathological) WITHOUT running bd — run it anyway
  # so the guard can never make bd fail. Any other rc is bd.real's own code.
  if [ "$rc" -eq 75 ]; then exec "$REAL" "$@"; fi
  exit "$rc"
fi
WRAPPER
chmod +x "$BIN/bd"
log "wrapper installed at $BIN/bd (cap=$MAX)"

# ---- 2. zshrc aliases (idempotent marked block) -------------------------
touch "$ZSHRC"
if grep -qF "$MARK_BEGIN" "$ZSHRC"; then
  log "alias block already in $ZSHRC — leaving as-is"
else
  {
    echo ""
    echo "$MARK_BEGIN"
    echo "# bd spawn-storm recovery. bdkill: nuke a runaway pileup. bdcount: live count."
    echo 'alias bdkill='"'"'pkill -f "/bd\.real" ; pkill -x bd.real ; echo "killed bd.real procs"'"'"
    echo 'alias bdcount='"'"'ps -Ao comm= | grep -c "bd\.real"'"'"
    echo "$MARK_END"
  } >> "$ZSHRC"
  log "appended bdkill/bdcount to $ZSHRC (run 'source ~/.zshrc')"
fi

# ---- 3. watchdog + LaunchAgent (macOS) ---------------------------------
cat > "$WATCHDOG" <<'WATCH'
#!/bin/bash
# bd runaway watchdog — safety net behind the bd guard. Kills bd.real if the
# count exceeds THRESHOLD (guard bypassed/disabled or a bd bug). Logs kills.
THRESHOLD="${BD_WATCHDOG_THRESHOLD:-20}"
LOG="$HOME/.local/state/bd-watchdog.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
list_pids() {
  ps -Ao etime=,pid=,comm= | awk '$3 ~ /bd\.real$/ {print $1, $2}' \
    | sort -r | awk '{print $2}'
}
pids="$(list_pids)"; count="$(printf '%s\n' "$pids" | grep -c .)"
if [ "$count" -gt "$THRESHOLD" ]; then
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] bd.real count=$count > $THRESHOLD — killing excess" >> "$LOG"
  n=$(( count - THRESHOLD ))
  printf '%s\n' "$pids" | head -n "$n" | while read -r p; do
    [ -n "$p" ] || continue
    kill -TERM "$p" 2>/dev/null && echo "[$ts]   TERM $p" >> "$LOG"
  done
  sleep 2
  pids2="$(list_pids)"; still="$(printf '%s\n' "$pids2" | grep -c .)"
  if [ "$still" -gt "$THRESHOLD" ]; then
    n2=$(( still - THRESHOLD ))
    printf '%s\n' "$pids2" | head -n "$n2" | while read -r p; do
      [ -n "$p" ] || continue; kill -9 "$p" 2>/dev/null
    done
    echo "[$ts]   escalated to KILL -9 (still=$still)" >> "$LOG"
  fi
fi
WATCH
chmod +x "$WATCHDOG"
log "watchdog installed at $WATCHDOG"

if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$WATCHDOG</string></array>
    <key>StartInterval</key><integer>30</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardErrorPath</key><string>$HOME/.local/state/bd-watchdog.err</string>
    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityIO</key><true/>
</dict>
</plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null && log "LaunchAgent loaded ($LABEL, 30s)" \
    || log "WARN: launchctl load failed — load manually: launchctl load $PLIST"
else
  log "non-macOS: skipped LaunchAgent. Cron equivalent: * * * * * $WATCHDOG"
fi

echo ""
echo "bd-guard installed. cap=$MAX concurrent bd.real (~$(( MAX * 154 ))MB worst case)."
echo "Verify:  BD_MAX_CONCURRENCY=$MAX ; for n in \$(seq 1 16); do bd list >/dev/null 2>&1 & done ; sleep 1"
echo "Bypass:  BD_NO_GUARD=1 bd ...   ·   Recovery:  bdkill / bdcount   ·   Remove:  $0 --uninstall"
