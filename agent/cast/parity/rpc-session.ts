#!/usr/bin/env bun
/**
 * One scripted `omp --mode rpc-ui` session against cast/parity/mock-llm.ts.
 *
 *   bun cast/parity/rpc-session.ts <omp-binary> <out-dir> <cwd> <mock-url> <model>
 *
 * Caller sets PI_CODING_AGENT_DIR (and ideally HOME) in the environment.
 * Sequence (mirrors how CAST drives omp): ready -> negotiate_protocol v2 ->
 * set_event_filter -> set_subagent_subscription -> set_ask_dialog -> get_state ->
 * prompt (mock replies with fixed text) -> prompt_result -> get_state -> stdin EOF.
 *
 * Writes <out-dir>/frames.jsonl (every frame, raw) and <out-dir>/summary.json
 * (frame-type sequence + shapes, normalised so two omp builds can be diffed).
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [bin, outDir, cwd, mockUrl, model] = process.argv.slice(2);
if (!bin || !outDir || !cwd || !mockUrl || !model) {
	console.error("usage: rpc-session.ts <omp-binary> <out-dir> <cwd> <mock-url> <model>");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const sessionDir = join(outDir, "sessions");
mkdirSync(sessionDir, { recursive: true });

const REPLY = "Hello from the CAST parity mock.";
await fetch(`${mockUrl}/ctl/reset`);
await fetch(`${mockUrl}/ctl/plan`, { method: "POST", body: JSON.stringify([{ text: REPLY, delayMs: 100 }]) });

const child = spawn(
	bin,
	["--mode", "rpc-ui", "--model", model, "--approval-mode", "yolo", "--session-dir", sessionDir, "--no-title"],
	{ cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: true },
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", d => (stderr += d));

const frames: any[] = [];
const waiters: { pred: (f: any) => boolean; res: (f: any) => void }[] = [];
let chunk: { parts: Buffer[]; count: number } | undefined;
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
	if (!line.trim()) return;
	let f = JSON.parse(line);
	if (f.type === "rpc_chunk") {
		if (f.index === 0) chunk = { parts: [], count: f.count };
		chunk!.parts.push(Buffer.from(f.data, "base64"));
		if (chunk!.parts.length < chunk!.count) return;
		f = JSON.parse(Buffer.concat(chunk!.parts).toString("utf8"));
		chunk = undefined;
	}
	frames.push(f);
	for (const w of [...waiters]) if (w.pred(f)) waiters.splice(waiters.indexOf(w), 1), w.res(f);
});

const waitFor = (pred: (f: any) => boolean, label: string, ms = 60_000) =>
	new Promise<any>((res, rej) => {
		const hit = frames.find(pred);
		if (hit) return res(hit);
		const t = setTimeout(() => rej(new Error(`timeout: ${label}\nstderr:\n${stderr.slice(-2000)}`)), ms);
		waiters.push({ pred, res: f => (clearTimeout(t), res(f)) });
	});
let seq = 0;
const call = (cmd: Record<string, unknown>) => {
	const id = (cmd.id as string) ?? `c${++seq}`;
	const p = waitFor(f => f.type === "response" && f.id === id, `response ${cmd.type}`);
	child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
	return p;
};

const exitCode = new Promise<number | null>(r => child.once("exit", c => r(c)));
let ok = false;
let error: string | undefined;
try {
	const ready = await waitFor(f => f.type === "ready", "ready");
	const neg = await call({ type: "negotiate_protocol", protocolVersion: 2 });
	await call({ type: "set_event_filter", events: null, messageUpdates: "delta" });
	await call({ type: "set_subagent_subscription", level: "progress" });
	await call({ type: "set_ask_dialog", enabled: true });
	const st0 = await call({ type: "get_state" });
	const ack = await call({ type: "prompt", id: "p1", message: "say hi" });
	const pr = await waitFor(f => f.type === "prompt_result" && f.id === "p1", "prompt_result");
	await waitFor(f => f.type === "session_settled", "session_settled");
	const st1 = await call({ type: "get_state" });
	const assistant = [...frames].reverse().find(f => f.type === "message_end" && f.message?.role === "assistant");
	const text = (assistant?.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
	ok = neg.success && ack.success && pr.status === "completed" && text === REPLY;
	writeFileSync(
		join(outDir, "result.json"),
		JSON.stringify(
			{
				ready: { protocolVersion: ready.protocolVersion, supported: ready.supportedProtocolVersions },
				negotiated: neg.data,
				promptAck: ack.success,
				promptResult: { status: pr.status, agentInvoked: pr.agentInvoked, sessionSettled: pr.sessionSettled },
				assistantText: text,
				state0Keys: Object.keys(st0.data ?? {}).sort(),
				state1Keys: Object.keys(st1.data ?? {}).sort(),
				state0Model: st0.data?.model && { id: st0.data.model.id, provider: st0.data.model.provider, api: st0.data.model.api },
				contextUsage1: st1.data?.contextUsage,
			},
			null,
			2,
		),
	);
} catch (e) {
	error = String(e);
} finally {
	try {
		child.stdin.end();
	} catch {}
	const t = setTimeout(() => {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {}
	}, 8000);
	await exitCode;
	clearTimeout(t);
}

// Normalised view for diffing two builds: the ordered frame types, with
// response frames tagged by command and session events by event subtype.
const tag = (f: any) =>
	f.type === "response"
		? `response:${f.command}:${f.success}`
		: f.type === "message_update"
			? `message_update:${f.assistantMessageEvent?.type}`
			: f.type === "extension_ui_request"
				? `extension_ui_request:${f.method}:${f.widgetKey ?? ""}`
				: f.type === "message_start" || f.type === "message_end"
					? `${f.type}:${f.message?.role}`
					: f.type;
const typeSeq = frames.map(tag);
// message_update deltas are chunk-timing dependent; collapse runs so the
// sequence compares the protocol, not the stream chunking.
const collapsed = typeSeq.filter((t, i) => !(t === "message_update:text_delta" && typeSeq[i - 1] === t));
writeFileSync(join(outDir, "frames.jsonl"), frames.map(f => JSON.stringify(f)).join("\n") + "\n");
writeFileSync(
	join(outDir, "summary.json"),
	JSON.stringify(
		{ ok, error, exit: await exitCode, frameCount: frames.length, frameTypes: [...new Set(frames.map(f => f.type))].sort(), typeSeq: collapsed },
		null,
		2,
	),
);
writeFileSync(join(outDir, "stderr.txt"), stderr);
console.log(`${ok ? "OK" : "FAIL"} ${bin} frames=${frames.length}${error ? ` error=${error.split("\n")[0]}` : ""}`);
process.exit(ok ? 0 : 1);
