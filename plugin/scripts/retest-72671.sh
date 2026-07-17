#!/usr/bin/env bash
# CC #72671 captured-header re-test for the CURRENTLY-INSTALLED Claude Code CLI.
# Points OTLP logs export straight at a local capture server (bypassing the
# forwarder) via `claude -p --settings` (shell env does NOT override
# settings.json; --settings does), with a known TRACEPARENT. Reports whether the
# export now carries Content-Length (fix #1) and the traceparent trace-id bytes
# appear in the body (fix #2). Run before RE-ACTIVATING the forwarder — see
# otlp-forwarder.README.md. Only re-enable the shim on a FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/otlp-capture.jsonl"
PORT="${1:-14319}"
TP_TRACE=0af7651916cd43dd8448eb211c80319c
TP_SPAN=b7ad6b7169203331
TRACEPARENT="00-${TP_TRACE}-${TP_SPAN}-01"

echo "== CLI version =="; claude --version || { echo "claude CLI not found"; exit 2; }

setsid nohup node "$HERE/otlp-capture-server.mjs" "$OUT" "$PORT" >"$WORK/cap.log" 2>&1 </dev/null &
CAP_PID=$!
sleep 1

SETTINGS=$(printf '{"env":{"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":"http://127.0.0.1:%s/v1/logs","TRACEPARENT":"%s"}}' "$PORT" "$TRACEPARENT")
for i in 1 2 3; do
  echo "== nested claude run $i =="
  timeout 120 claude -p "Reply with only the word: hi" --settings "$SETTINGS" >>"$WORK/claude.log" 2>&1
  sleep 4
  [ -s "$OUT" ] && break
done
sleep 1
kill "$CAP_PID" 2>/dev/null

if [ ! -s "$OUT" ]; then echo "NO EXPORTS CAPTURED (nested run may not have emitted / flushed)"; exit 3; fi

python3 - "$OUT" "$TP_TRACE" "$TP_SPAN" <<'PY'
import sys, json, binascii, glob
out, tp_trace, tp_span = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [json.loads(l) for l in open(out) if l.strip()]
print(f"exports captured: {len(rows)}")
for i, r in enumerate(rows, 1):
    print(f"  [{i}] http/{r['httpVersion']}  transfer-encoding={r['transferEncoding']}  content-length={r['contentLength']}  bytes={r['bodyBytes']}")
cl_ok = all(r['contentLength'] is not None and not r['transferEncoding'] for r in rows)
print(f"\nFIX #1 (Content-Length, not chunked): {'PASS' if cl_ok else 'FAIL'}")
tb, sb = binascii.unhexlify(tp_trace), binascii.unhexlify(tp_span)
ft = any(tb in open(b,'rb').read() for b in glob.glob(out + '.*.bin'))
fs = any(sb in open(b,'rb').read() for b in glob.glob(out + '.*.bin'))
print(f"FIX #2 (trace_id in log records w/ TRACEPARENT): {'PASS' if ft else 'FAIL'}  (span_id: {'found' if fs else 'missing'})")
print("\n→ If FIX #1 is FAIL, re-activate the forwarder: TOKENSCOPE_OTLP_PROXY=1")
PY
