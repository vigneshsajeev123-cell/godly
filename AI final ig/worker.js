// Web Worker: runs the whole (pure) scheduling pipeline off the main thread.
import { generateTimetable, generateBaselineTimetable } from './scheduler.js';

self.onmessage = (e) => {
  const { id, workload, config, options, algorithm = 'CSP' } = e.data;
  try {
    const result = algorithm === 'CSP'
      ? generateTimetable(workload, config, options)
      : generateBaselineTimetable(workload, config, algorithm, options?.limits);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
