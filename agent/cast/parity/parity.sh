#!/usr/bin/env bash
# Compare two agent builds (e.g. cast-agent before/after porting an upstream
# fix, or against another omp build) on: --version, `models --json`, and one
# scripted rpc-ui session answered by a local mock LLM. No keys, no network
# calls to real providers; everything is written under <work-dir>.
#
#   cast/parity/parity.sh <agent-A> <agent-B> <work-dir> [mock-port]
#
# Each side runs with the SAME paths (agent dir, HOME, cwd) freshly recreated,
# so outputs are comparable byte-for-byte. Exit 0 = parity, 1 = differences.
set -uo pipefail
A="${1:?agent A}"; B="${2:?agent B}"; W="${3:?work dir}"; PORT="${4:-5397}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_URL="http://127.0.0.1:$PORT"
MODEL="anthropic/claude-opus-5-5"
mkdir -p "$W"
W="$(cd "$W" && pwd)"
MOCK_PID=""
stop_mock() { if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=""; fi; }
trap stop_mock EXIT

fresh_env() { # same absolute paths for both sides, recreated empty each time
	rm -rf "$W/agent" "$W/home" "$W/work"
	mkdir -p "$W/agent" "$W/home" "$W/work"
	sed "s|__MOCK_URL__|$MOCK_URL|" "$HERE/models.yml" > "$W/agent/models.yml"
}
run_omp() { # run_omp <bin> args... — isolated env
	env -u XDG_DATA_HOME -u XDG_CONFIG_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME \
		HOME="$W/home" PI_CODING_AGENT_DIR="$W/agent" "$@"
}

side() { # side <label> <bin>
	local label="$1" bin="$2" out="$W/$1"
	rm -rf "$out"; mkdir -p "$out"
	MOCK_PORT="$PORT" MOCK_DIR="$out/mock" bun "$HERE/mock-llm.ts" > "$out/mock.log" 2>&1 &
	MOCK_PID=$!
	for _ in $(seq 50); do curl -sf "$MOCK_URL/ctl/state" >/dev/null && break; sleep 0.1; done
	fresh_env
	(cd "$W/work" && run_omp "$bin" --version) > "$out/version.txt" 2>"$out/version.err"
	fresh_env
	(cd "$W/work" && run_omp "$bin" models --json) > "$out/models.json" 2>"$out/models.err"
	fresh_env
	run_omp bun "$HERE/rpc-session.ts" "$bin" "$out/rpc" "$W/work" "$MOCK_URL" "$MODEL"
	stop_mock
	# what omp sent to the LLM: tool names + system prompt (dates/paths are identical by construction)
	if [ -f "$out/mock/req/req-1.json" ]; then
		jq -S '{model, tools: [.tools[]?.function.name], system: .messages[0].content, roles: [.messages[].role]}' \
			"$out/mock/req/req-1.json" > "$out/llm-request.json"
	fi
}

side A "$A"
side B "$B"

fail=0
check() { # check <name> <fileA> <fileB>
	if cmp -s "$1" "$2"; then echo "SAME  $3"; else echo "DIFF  $3"; diff <(head -c 200000 "$1") <(head -c 200000 "$2") | head -20; fail=1; fi
}
echo "A=$A ($(cat "$W/A/version.txt"))"
echo "B=$B ($(cat "$W/B/version.txt"))"
check "$W/A/version.txt" "$W/B/version.txt" "--version"
check "$W/A/models.json" "$W/B/models.json" "models --json ($(jq 'if type=="array" then length else (.models|length) end' "$W/A/models.json" 2>/dev/null) entries, $(wc -c < "$W/A/models.json") bytes)"
jq '.typeSeq' "$W/A/rpc/summary.json" > "$W/A/rpc/typeSeq.json"; jq '.typeSeq' "$W/B/rpc/summary.json" > "$W/B/rpc/typeSeq.json"
check "$W/A/rpc/typeSeq.json" "$W/B/rpc/typeSeq.json" "rpc-ui frame sequence ($(jq '.frameCount' "$W/A/rpc/summary.json") vs $(jq '.frameCount' "$W/B/rpc/summary.json") frames; types: $(jq -c '.frameTypes' "$W/A/rpc/summary.json"))"
check "$W/A/rpc/result.json" "$W/B/rpc/result.json" "rpc-ui results (negotiate/get_state keys/prompt_result/reply text)"
check "$W/A/llm-request.json" "$W/B/llm-request.json" "request sent to the LLM (system prompt + $(jq '.tools|length' "$W/A/llm-request.json") tools)"
echo "rpc ok: A=$(jq .ok "$W/A/rpc/summary.json") B=$(jq .ok "$W/B/rpc/summary.json")"
[ "$(jq .ok "$W/A/rpc/summary.json")" = true ] && [ "$(jq .ok "$W/B/rpc/summary.json")" = true ] || fail=1
[ $fail = 0 ] && echo "PARITY: OK" || echo "PARITY: DIFFERENCES (see $W)"
exit $fail
