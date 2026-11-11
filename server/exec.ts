// Run a subprocess with a timeout and capture its output. Used by GitService and project creation.

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Stop collecting stdout past this many bytes (the process keeps running to completion). */
  maxStdoutBytes?: number;
  /** Fed to stdin (otherwise stdin is closed). */
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (size >= cap) {
      truncated = true;
      continue; // keep draining so the child never blocks on a full pipe
    }
    const room = cap - size;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      size = cap;
      truncated = true;
    } else {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Merge env overrides into process.env; an override set to undefined removes that variable. */
function mergeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...overrides })) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
  return env;
}

export async function exec(cmd: string[], opts: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: mergeEnv(opts.env),
    stdin: opts.input === undefined ? 'ignore' : Buffer.from(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, opts.timeoutMs ?? 20_000);
  try {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout, opts.maxStdoutBytes ?? 64 * 1024 * 1024),
      readCapped(proc.stderr, 256 * 1024),
      proc.exited,
    ]);
    return { code: timedOut ? -1 : code, stdout: out.text, stderr: err.text, truncated: out.truncated, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
