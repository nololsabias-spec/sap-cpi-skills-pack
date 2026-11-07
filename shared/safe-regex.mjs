/**
 * Sandboxed, time-limited regular expression evaluation (zero dependencies).
 *
 * User-supplied patterns can trigger catastrophic backtracking (ReDoS), e.g. ^(a|aa)*$ against
 * "aaaa…b", which freezes the single-threaded MCP server. Patterns run inside a worker thread;
 * the caller blocks on Atomics.wait with a timeout and terminates the worker if it expires.
 * The API stays synchronous so existing callers do not need to become async.
 */
import { Worker } from 'node:worker_threads';

const WORKER_SRC = `
const { workerData } = require('node:worker_threads');
const { pattern, flags, inputs, sab } = workerData;
const ctl = new Int32Array(sab, 0, 2);
const out = new Uint8Array(sab, 8);
let result;
try {
  const rx = new RegExp(pattern, flags);
  result = {
    ok: true,
    results: inputs.map((value) => {
      rx.lastIndex = 0;
      const m = rx.exec(value);
      return m ? { match: true, groups: Array.from(m).slice(1).map((g) => (g === undefined ? null : g)) } : { match: false, groups: [] };
    })
  };
} catch (err) {
  result = { ok: false, syntaxError: true, error: err.message };
}
let bytes = Buffer.from(JSON.stringify(result), 'utf8');
if (bytes.length > out.length) {
  bytes = Buffer.from(JSON.stringify({ ok: false, error: 'Resultado demasiado grande para el sandbox de regex.' }), 'utf8');
}
out.set(bytes);
Atomics.store(ctl, 1, bytes.length);
Atomics.store(ctl, 0, 1);
Atomics.notify(ctl, 0);
`;

export const DEFAULT_REGEX_TIMEOUT_MS = 1500;

/**
 * Evaluates `pattern` against each input with a hard timeout.
 * @returns {{ ok: boolean, results?: Array<{match:boolean, groups:(string|null)[]}>, timedOut?: boolean, syntaxError?: boolean, error?: string }}
 */
export function safeRegexExecAll(pattern, inputs = [], { flags = '', timeoutMs = DEFAULT_REGEX_TIMEOUT_MS } = {}) {
  const list = (inputs || []).map((v) => String(v ?? ''));
  const inputBytes = list.reduce((n, v) => n + Buffer.byteLength(v), 0);
  const sab = new SharedArrayBuffer(8 + Math.max(64 * 1024, inputBytes * 4 + 4096));
  const ctl = new Int32Array(sab, 0, 2);
  let worker;
  try {
    worker = new Worker(WORKER_SRC, { eval: true, workerData: { pattern: String(pattern), flags, inputs: list, sab } });
  } catch (err) {
    return { ok: false, error: `No se pudo iniciar el sandbox de regex: ${err.message}` };
  }
  worker.unref();
  worker.on('error', () => {});
  const state = Atomics.wait(ctl, 0, 0, timeoutMs);
  if (state === 'timed-out' && Atomics.load(ctl, 0) === 0) {
    worker.terminate().catch(() => {});
    return {
      ok: false,
      timedOut: true,
      error: `La evaluación del regex superó ${timeoutMs} ms (probable Catastrophic Backtracking / ReDoS). Abortada.`
    };
  }
  const len = Atomics.load(ctl, 1);
  const json = Buffer.from(new Uint8Array(sab, 8, len)).toString('utf8');
  worker.terminate().catch(() => {});
  try {
    return JSON.parse(json);
  } catch {
    return { ok: false, error: 'Respuesta ilegible del sandbox de regex.' };
  }
}

/** Convenience: returns the index of the first input that matches, -1 if none, or null on timeout/error. */
export function safeRegexFindIndex(pattern, inputs, opts) {
  const r = safeRegexExecAll(pattern, inputs, opts);
  if (!r.ok) return null;
  return r.results.findIndex((x) => x.match);
}
