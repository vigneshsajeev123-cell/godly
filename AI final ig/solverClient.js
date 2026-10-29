// Main-thread helper: run generateTimetable in a Web Worker; fall back to a deferred main-thread call
// if Workers are unavailable (e.g. restrictive file:// contexts).
import { generateTimetable, generateBaselineTimetable } from './scheduler.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Worker error'));
    pending.clear();
    worker = null;
  };
  return worker;
}

export function runScheduler(workload, config, options, algorithm = 'CSP') {
  try {
    const w = getWorker();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, workload, config, options, algorithm });
    });
  } catch {
    return new Promise((resolve) => setTimeout(() => resolve(algorithm === 'CSP' ? generateTimetable(workload, config, options) : generateBaselineTimetable(workload, config, algorithm, options?.limits)), 30));
  }
}
