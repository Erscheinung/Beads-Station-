#!/usr/bin/env bash
# Code-1bw: fake-claude stub for integration testing.
# Emits a scripted stream-json session to stdout, then exits.
# Usage: BS_CLAUDE_BIN=/path/to/fake-claude.sh claude_start ...
#
# Env overrides:
#   FAKE_CLAUDE_DELAY_MS   — ms between frames (default 50)
#   FAKE_CLAUDE_ERROR      — if set, emit a line to stderr and exit 1
#   FAKE_CLAUDE_FRAMES     — JSON array of frames to emit (override defaults)

DELAY=${FAKE_CLAUDE_DELAY_MS:-50}
SESSION_ID="fake-session-$(date +%s)"

sleep_ms() {
  python3 -c "import time; time.sleep($1/1000.0)" 2>/dev/null || sleep 0.05
}

if [[ -n "$FAKE_CLAUDE_ERROR" ]]; then
  echo "Error: $FAKE_CLAUDE_ERROR" >&2
  exit 1
fi

# Emit init frame
printf '{"type":"system","subtype":"init","session_id":"%s","tools":[]}\n' "$SESSION_ID"
sleep_ms "$DELAY"

# Read one user message from stdin (fire-and-forget — the stub ignores content)
read -r -t 5 _user_msg 2>/dev/null || true

# Emit assistant response
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK1"}]}}\n'
sleep_ms "$DELAY"

# Emit result frame
printf '{"type":"result","subtype":"success","session_id":"%s","cost_usd":0.0001,"usage":{"input_tokens":5,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n' "$SESSION_ID"
sleep_ms "$DELAY"

# Second turn: read + respond
read -r -t 5 _user_msg2 2>/dev/null || true
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK2"}]}}\n'
sleep_ms "$DELAY"
printf '{"type":"result","subtype":"success","session_id":"%s","cost_usd":0.0002,"usage":{"input_tokens":8,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n' "$SESSION_ID"

# EOF — child exits cleanly, triggering the exit monitor (Code-key)
