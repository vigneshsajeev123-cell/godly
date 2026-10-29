// scheduler.js — pure scheduling logic. NO DOM access; runs in the browser, in a Web Worker, and in Node.
//
// Sections:
//   1. Names, CSV parsing, workload canonicalisation
//   2. Config / context normalisation, unavailability + preference text parsers
//   3. Declarative rule set (hard + soft)  -> used by solver, preflight, auditor and optimizer
//   4. Auditor and soft-cost evaluation
//   5. Pre-flight feasibility analysis
//   6. CSP solver (unary reduction, symmetry breaking, AC-3, forward checking, MRV+degree, LCV, trail)
//   7. Local-search optimizer (simulated annealing, hard-constraint-preserving moves)
//   8. generateTimetable() pipeline

// ============================================================================
// 1. NAMES + CSV
// ============================================================================

/** Identity key for faculty / batch / subject / room names: trim, collapse spaces, case-insensitive. */
export const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
/** Display form: trimmed, collapsed whitespace, original case. */
export const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Max weekly hours of ONE subject for a grid. Sessions of one subject always need distinct slots
 *  (same batch cannot be in two places), so the grid size is a hard upper bound. */
export const maxHoursForGrid = (dayCount, slotsPerDay) => Math.max(0, dayCount) * Math.max(0, slotsPerDay);

/** Split one CSV line. Only `"` toggles quote state; `""` inside quotes is an escaped quote.
 *  Apostrophes are ordinary characters (O'Brien). `result.unterminated` is true if a quote never closed. */
export function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  const res = out.map((s) => s.trim());
  res.unterminated = inQ;
  return res;
}

/** Quote a field for CSV output (always quoted, embedded quotes doubled). */
export const csvQuote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
/** Quote only when needed (used for the editable workload textarea). */
export const csvField = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? csvQuote(s) : s;
};

/** Give every faculty / batch one display name (first spelling seen) so "Prof X" and "prof x" are one person. */
export function canonicalizeWorkload(rows) {
  const batchDisp = new Map();
  const facDisp = new Map();
  return rows.map((r) => {
    const bk = normName(r.batch), fk = normName(r.faculty);
    if (!batchDisp.has(bk)) batchDisp.set(bk, cleanName(r.batch));
    if (!facDisp.has(fk)) facDisp.set(fk, cleanName(r.faculty));
    return { ...r, batch: batchDisp.get(bk), faculty: facDisp.get(fk), subject: cleanName(r.subject) };
  });
}

/**
 * Parse CSV text: Batch,Subject,Faculty_Name,Is_Lab,Weekly_Hours.
 * Nothing is silently changed. Every problem becomes an entry in `errors`
 * ({row, field, value, message}); `row` is the 1-based line number in the text (header = line 1).
 * Invalid rows are NOT included in `rows`.
 * @param {{maxHours?: number}} opts maxHours = allowed weekly hours per subject (use maxHoursForGrid()).
 */
export function parseCSV(text, opts = {}) {
  const maxHours = opts.maxHours ?? Infinity;
  const errors = [];
  const rows = [];
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let hdrLine = lines.findIndex((l) => l.trim() !== '');
  if (hdrLine < 0) {
    errors.push({ row: 0, field: null, value: '', message: 'CSV is empty.' });
    return { rows, errors };
  }
  const headers = parseCSVLine(lines[hdrLine]).map((h) => h.toLowerCase());
  const find = (pred) => headers.findIndex(pred);
  const batchIdx = find((h) => h === 'batch');
  const subjectIdx = find((h) => h === 'subject' || h === 'course');
  const facultyIdx = find((h) => h.includes('faculty') || h.includes('teacher'));
  const labIdx = find((h) => h.includes('lab'));
  const hoursIdx = find((h) => h.includes('hour') || h.includes('weekly') || h.includes('credits'));
  const missing = [['Batch', batchIdx], ['Subject', subjectIdx], ['Faculty_Name', facultyIdx], ['Is_Lab', labIdx], ['Weekly_Hours', hoursIdx]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    errors.push({ row: hdrLine + 1, field: 'header', value: lines[hdrLine], message: `Missing column(s): ${missing.join(', ')}.` });
    return { rows, errors };
  }

  const seen = new Map(); // dup key -> line number
  for (let i = hdrLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const row = i + 1;
    const parts = parseCSVLine(raw);
    const bad = (field, value, message) => { errors.push({ row, field, value, message: `Row ${row}: ${message}` }); };
    if (parts.unterminated) { bad(null, raw, 'unterminated quote.'); continue; }
    if (parts.length < headers.length) { bad(null, raw, `expected ${headers.length} columns but found ${parts.length}.`); continue; }

    const batch = cleanName(parts[batchIdx]);
    const subject = cleanName(parts[subjectIdx]);
    const faculty = cleanName(parts[facultyIdx]);
    const labRaw = parts[labIdx].trim().toLowerCase();
    const hoursRaw = parts[hoursIdx].trim();
    let ok = true;
    if (!batch) { bad('Batch', '', 'Batch is empty.'); ok = false; }
    if (!subject) { bad('Subject', '', 'Subject is empty.'); ok = false; }
    if (!faculty) { bad('Faculty_Name', '', 'Faculty_Name is empty.'); ok = false; }
    let isLab = false;
    if (['true', '1', 'yes', 'y', 't'].includes(labRaw)) isLab = true;
    else if (['false', '0', 'no', 'n', 'f'].includes(labRaw)) isLab = false;
    else { bad('Is_Lab', parts[labIdx], `Is_Lab "${parts[labIdx]}" is not true/false.`); ok = false; }

    let weeklyHours = NaN;
    if (!/^\d+$/.test(hoursRaw)) {
      bad('Weekly_Hours', hoursRaw, `Weekly_Hours "${hoursRaw}" is not a whole number.`); ok = false;
    } else {
      weeklyHours = parseInt(hoursRaw, 10);
      if (weeklyHours < 1) { bad('Weekly_Hours', hoursRaw, `Weekly_Hours ${weeklyHours} must be at least 1.`); ok = false; }
      else if (weeklyHours > maxHours) {
        bad('Weekly_Hours', hoursRaw, `Weekly_Hours ${weeklyHours} exceeds the maximum of ${maxHours} allowed by the day/slot grid.`); ok = false;
      }
    }
    if (!ok) continue;
    const dupKey = `${normName(batch)}|${normName(subject)}|${isLab ? 1 : 0}`;
    if (seen.has(dupKey)) {
      bad(null, raw, `duplicate of row ${seen.get(dupKey)} (same batch and subject); not added twice.`);
      continue;
    }
    seen.set(dupKey, row);
    rows.push({ batch, subject, faculty, isLab, weeklyHours, line: row });
  }
  return { rows: canonicalizeWorkload(rows), errors };
}

/** Expand weekly hours into unit sessions (problem reduction step 1). */
export function expandWorkloadToVariables(workload) {
  const rows = canonicalizeWorkload(workload);
  const variables = [];
  rows.forEach((item, itemIndex) => {
    for (let h = 0; h < item.weeklyHours; h++) {
      variables.push({
        id: `var_${variables.length}`,
        index: variables.length,
        itemIndex,
        batch: item.batch, batchKey: normName(item.batch),
        subject: item.subject, subjectKey: normName(item.subject),
        faculty: item.faculty, facultyKey: normName(item.faculty),
        isLab: !!item.isLab,
        sessionIndex: h + 1,
        totalHours: item.weeklyHours,
      });
    }
  });
  return variables;
}

// ============================================================================
// 2. CONFIG / CONTEXT
// ============================================================================

export const DEFAULT_RULE_CONFIG = Object.freeze({
  // Penalty per class placed in slot 1 (index 0) for the listed batches. batches: ['all'] or names.
  firstHour: { enabled: true, weight: 3, batches: [] },
  // "Consecutive labs": the SAME batch has lab sessions in two ADJACENT slots on the same day (any lab subjects).
  // One violation per adjacent pair. Optionally also one violation for every lab beyond maxLabsPerDay in a day (0 = off).
  consecutiveLabs: { enabled: false, weight: 4, batches: ['all'], maxLabsPerDay: 0 },
  // Faculty gaps: for each faculty member and day, idle slots between first and last class. Violation unit = one gap-hour.
  facultyGaps: { enabled: true, weight: 1 },
  // Preferred slots: prefs = [{kind:'batch'|'faculty'|'subject', name, slots:[0-based slot indexes]}].
  // One violation per (session, matching preference) when the session is outside that preference's slots.
  preferredSlots: { enabled: true, weight: 2, prefs: [] },
});

export const DEFAULT_LIMITS = Object.freeze({ maxNodes: 40000, maxTimeMs: 4000, mac: false, symmetry: true });
export const DEFAULT_OPTIMIZER = Object.freeze({ enabled: true, seed: 12345, maxIterations: 20000, maxTimeMs: 1500 });

export function mergeRuleConfig(rc = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_RULE_CONFIG)) out[k] = { ...DEFAULT_RULE_CONFIG[k], ...(rc[k] || {}) };
  return out;
}

/**
 * Build the normalised context used by every other function.
 * config = {workingDays, slotsPerDay, theoryRooms, labRooms, unavailable?, rules?}
 * Returns {ok:false, errors:[...]} for an invalid configuration (e.g. room in both lists).
 */
export function buildContext(config, workload = []) {
  const errors = [];
  const days = [];
  const dayKeys = new Set();
  for (const d of config.workingDays || []) {
    const c = cleanName(d);
    if (c && !dayKeys.has(normName(c))) { dayKeys.add(normName(c)); days.push(c); }
  }
  if (days.length === 0) errors.push('At least one working day is required.');
  const S = Number(config.slotsPerDay);
  if (!Number.isInteger(S) || S < 1) errors.push(`Slots per day must be a whole number ≥ 1 (got "${config.slotsPerDay}").`);

  const dedupe = (list) => {
    const seen = new Set();
    const out = [];
    for (const r of list || []) {
      const name = cleanName(r);
      if (!name || seen.has(normName(name))) continue;
      seen.add(normName(name));
      out.push({ name, key: normName(name) });
    }
    return out;
  };
  const theory = dedupe(config.theoryRooms);
  const lab = dedupe(config.labRooms);
  const theoryKeys = new Set(theory.map((r) => r.key));
  for (const r of lab) {
    if (theoryKeys.has(r.key)) errors.push(`Room "${r.name}" appears in both the theory and the lab room lists. A room must be exactly one type.`);
  }
  if (errors.length) return { ok: false, errors };

  const rooms = [...theory.map((r) => ({ ...r, isLab: false })), ...lab.map((r) => ({ ...r, isLab: true }))];
  const roomIndex = new Map(rooms.map((r, i) => [r.key, i]));
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  for (const [d, i] of [...dayIndex]) dayIndex.set(normName(d), i);
  const T = days.length * S;

  const unavailable = { faculty: new Map(), batch: new Map() };
  for (const e of config.unavailable || []) {
    const map = unavailable[e.kind];
    if (!map) continue;
    const key = normName(e.name);
    if (!map.has(key)) map.set(key, new Set());
    for (const { day, slot } of e.times) {
      const di = dayIndex.get(day) ?? dayIndex.get(normName(day));
      if (di !== undefined && slot >= 0 && slot < S) map.get(key).add(di * S + slot);
    }
  }

  const canon = canonicalizeWorkload(workload);
  const required = new Map(); // batchKey|subjectKey|lab -> {batch, subject, required}
  for (const r of canon) {
    const k = `${normName(r.batch)}|${normName(r.subject)}|${r.isLab ? 1 : 0}`;
    const cur = required.get(k);
    if (cur) cur.required += r.weeklyHours;
    else required.set(k, { batch: r.batch, subject: r.subject, isLab: !!r.isLab, required: r.weeklyHours });
  }

  return {
    ok: true, errors: [], days, S, D: days.length, T, theory, lab, rooms, R: rooms.length, roomIndex, dayIndex,
    unavailable, workload: canon, required, ruleConfig: mergeRuleConfig(config.rules),
  };
}

/** Parse "batch:S5 CSE-A=2,3  /  faculty:Dr X=1-3  /  subject:Maths=2" (slots are 1-based in text). */
export function parsePreferredSlotsText(text, slotsPerDay) {
  const prefs = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^(batch|faculty|subject)\s*:\s*(.+?)\s*=\s*([\d,\s-]+)$/i);
    if (!m) { errors.push(`Preferred slots line ${i + 1}: "${line}" — expected kind:name=1,2,3 (kind = batch, faculty or subject).`); return; }
    const slots = parseSlotList(m[3], slotsPerDay);
    if (!slots) { errors.push(`Preferred slots line ${i + 1}: slot list "${m[3]}" must use numbers 1–${slotsPerDay}.`); return; }
    prefs.push({ kind: m[1].toLowerCase(), name: cleanName(m[2]), slots });
  });
  return { prefs, errors };
}

/** Parse "faculty:Prof X=Mon:*;Tue:1,2" (slots 1-based, * = all slots). */
export function parseUnavailabilityText(text, days, slotsPerDay) {
  const entries = [];
  const errors = [];
  const dayMap = new Map(days.map((d) => [normName(d), d]));
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^(batch|faculty)\s*:\s*(.+?)\s*=\s*(.+)$/i);
    if (!m) { errors.push(`Unavailability line ${i + 1}: "${line}" — expected kind:name=Day:slots;Day:slots.`); return; }
    const times = [];
    let bad = false;
    for (const part of m[3].split(';')) {
      const pm = part.trim().match(/^([A-Za-z]+)\s*:\s*(\*|[\d,\s-]+)$/);
      const day = pm && dayMap.get(normName(pm[1]));
      const slots = pm && (pm[2] === '*' ? Array.from({ length: slotsPerDay }, (_, s) => s) : parseSlotList(pm[2], slotsPerDay));
      if (!pm || !day || !slots) { errors.push(`Unavailability line ${i + 1}: cannot read "${part.trim()}".`); bad = true; break; }
      slots.forEach((s) => times.push({ day, slot: s }));
    }
    if (!bad) entries.push({ kind: m[1].toLowerCase(), name: cleanName(m[2]), times });
  });
  return { entries, errors };
}

function parseSlotList(text, slotsPerDay) {
  const out = new Set();
  for (const tok of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = tok.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!r) return null;
    const a = +r[1], b = r[2] ? +r[2] : a;
    if (a < 1 || b < a || b > slotsPerDay) return null;
    for (let s = a; s <= b; s++) out.add(s - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

// ============================================================================
// 3. DECLARATIVE RULE SET
// ============================================================================
// Every rule: {id, type:'hard'|'soft', scope, description, weight, enabled, check(ctx, assignment) -> {count, details, ...}}
// Hard rules additionally expose machinery the solver uses (so the solver and auditor share one definition):
//   keyOf(item)              clash-rules: items with the same key may not share (day, slot)
//   unary(variable, room|t)  unary-domain filters (room type, availability)
// Soft rules: check() returns the number of violation units; cost = weight * count (only if enabled).

const timeOf = (ctx, it) => {
  const d = ctx.dayIndex.get(it.day) ?? ctx.dayIndex.get(normName(it.day));
  if (d === undefined || !Number.isInteger(it.slot) || it.slot < 0 || it.slot >= ctx.S) return -1;
  return d * ctx.S + it.slot;
};
const keyFac = (it) => it.facultyKey ?? normName(it.faculty);
const keyBat = (it) => it.batchKey ?? normName(it.batch);
const keySub = (it) => it.subjectKey ?? normName(it.subject);
const keyRoom = (it) => normName(it.room);

function clashRule(id, scope, description, keyOf) {
  return {
    id, type: 'hard', scope, description, weight: Infinity, enabled: true, keyOf,
    check(ctx, asg) {
      const seen = new Map();
      let count = 0;
      const details = [];
      for (const it of asg) {
        const t = timeOf(ctx, it);
        if (t < 0) continue; // reported by H6
        const k = `${keyOf(it)}#${t}`;
        if (seen.has(k)) {
          count++;
          if (details.length < 25) details.push(`${it.day} slot ${it.slot + 1}: ${scope} "${scope === 'faculty' ? it.faculty : scope === 'batch' ? it.batch : it.room}" used by "${seen.get(k).subject}" and "${it.subject}"`);
        } else seen.set(k, it);
      }
      return { count, details };
    },
  };
}

function matchBatches(list) {
  const arr = (list || []).map(normName).filter(Boolean);
  return { all: arr.includes('all'), set: new Set(arr) };
}

export function buildRules(ctx) {
  const rc = ctx.ruleConfig;
  const w = (r) => (r.enabled ? Math.max(0, Number(r.weight) || 0) : 0);

  const H1 = clashRule('H1_FACULTY_CLASH', 'faculty', 'A faculty member cannot teach two classes in the same day and slot.', keyFac);
  const H2 = clashRule('H2_ROOM_CLASH', 'room', 'A room cannot host two classes in the same day and slot.', keyRoom);
  const H3 = clashRule('H3_BATCH_CLASH', 'batch', 'A batch cannot attend two subjects in the same day and slot.', keyBat);

  const H4 = {
    id: 'H4_ROOM_TYPE', type: 'hard', scope: 'room', weight: Infinity, enabled: true,
    description: 'Lab sessions use only lab rooms; theory sessions use only theory rooms.',
    unary: (variable, roomIdx) => ctx.rooms[roomIdx].isLab === !!variable.isLab,
    check(c, asg) {
      let count = 0;
      const details = [];
      for (const it of asg) {
        const ri = c.roomIndex.get(keyRoom(it));
        if (ri === undefined || c.rooms[ri].isLab !== !!it.isLab) {
          count++;
          if (details.length < 25) details.push(`"${it.subject}" (${it.isLab ? 'lab' : 'theory'}) placed in ${ri === undefined ? 'unknown room' : c.rooms[ri].isLab ? 'lab room' : 'theory room'} "${it.room}"`);
        }
      }
      return { count, details };
    },
  };

  const H5 = {
    id: 'H5_WEEKLY_HOURS', type: 'hard', scope: 'subject', weight: Infinity, enabled: true,
    description: 'Every (batch, subject) receives EXACTLY its required weekly hours.',
    check(c, asg) {
      const actual = new Map();
      const meta = new Map();
      for (const it of asg) {
        if (it.isFiller) continue; // filler sessions never count toward required hours
        const k = `${keyBat(it)}|${keySub(it)}|${it.isLab ? 1 : 0}`;
        actual.set(k, (actual.get(k) || 0) + 1);
        if (!meta.has(k)) meta.set(k, { batch: it.batch, subject: it.subject, isLab: !!it.isLab });
      }
      const table = [];
      let count = 0;
      const details = [];
      for (const [k, req] of c.required) {
        const a = actual.get(k) || 0;
        const ok = a === req.required;
        table.push({ batch: req.batch, subject: req.subject, isLab: req.isLab, required: req.required, actual: a, ok });
        if (!ok) { count++; details.push(`${req.batch} / ${req.subject}: required ${req.required}h, scheduled ${a}h`); }
      }
      for (const [k, a] of actual) {
        if (c.required.has(k)) continue;
        const m = meta.get(k);
        table.push({ batch: m.batch, subject: m.subject, isLab: m.isLab, required: 0, actual: a, ok: false });
        count++;
        details.push(`${m.batch} / ${m.subject}: not in the workload but ${a}h scheduled`);
      }
      return { count, details, table };
    },
  };

  const H6 = {
    id: 'H6_GRID_AVAILABILITY', type: 'hard', scope: 'slot', weight: Infinity, enabled: true,
    description: 'Sessions lie inside the day/slot grid and outside declared faculty/batch unavailability.',
    unary: (variable, t) => {
      const f = ctx.unavailable.faculty.get(variable.facultyKey);
      const b = ctx.unavailable.batch.get(variable.batchKey);
      return !(f && f.has(t)) && !(b && b.has(t));
    },
    check(c, asg) {
      let count = 0;
      const details = [];
      for (const it of asg) {
        const t = timeOf(c, it);
        let why = null;
        if (t < 0) why = 'outside the day/slot grid';
        else {
          const f = c.unavailable.faculty.get(keyFac(it));
          const b = c.unavailable.batch.get(keyBat(it));
          if (f && f.has(t)) why = `faculty ${it.faculty} unavailable`;
          else if (b && b.has(t)) why = `batch ${it.batch} unavailable`;
        }
        if (why) { count++; if (details.length < 25) details.push(`"${it.subject}" ${it.day} slot ${it.slot + 1}: ${why}`); }
      }
      return { count, details };
    },
  };

  const fh = rc.firstHour;
  const S1 = {
    id: 'S1_AVOID_FIRST_HOUR', type: 'soft', scope: 'batch', enabled: !!fh.enabled, weight: w(fh), config: fh,
    description: 'Avoid classes in slot 1 for the selected batches (penalty per class in slot 1).',
    check(c, asg) {
      const m = matchBatches(fh.batches);
      let count = 0;
      const details = [];
      for (const it of asg) {
        if (it.slot === 0 && (m.all || m.set.has(keyBat(it)))) { count++; if (details.length < 25) details.push(`${it.batch} · ${it.subject} on ${it.day} in slot 1`); }
      }
      return { count, details };
    },
  };

  const cl = rc.consecutiveLabs;
  const S2 = {
    id: 'S2_AVOID_CONSECUTIVE_LABS', type: 'soft', scope: 'batch', enabled: !!cl.enabled, weight: w(cl), config: cl,
    description: 'Avoid a batch having lab sessions in adjacent slots on the same day (and optionally more than N labs a day).',
    check(c, asg) {
      const m = matchBatches(cl.batches);
      const maxPerDay = Math.max(0, parseInt(cl.maxLabsPerDay, 10) || 0);
      const byBatchDay = new Map();
      for (const it of asg) {
        if (!it.isLab || !(m.all || m.set.has(keyBat(it)))) continue;
        const k = `${keyBat(it)}#${it.day}`;
        if (!byBatchDay.has(k)) byBatchDay.set(k, { batch: it.batch, day: it.day, slots: [] });
        byBatchDay.get(k).slots.push(it.slot);
      }
      let count = 0;
      const details = [];
      for (const g of byBatchDay.values()) {
        const s = [...new Set(g.slots)].sort((a, b) => a - b);
        for (let i = 1; i < s.length; i++) {
          if (s[i] === s[i - 1] + 1) { count++; if (details.length < 25) details.push(`${g.batch} ${g.day}: labs in slots ${s[i - 1] + 1} and ${s[i] + 1}`); }
        }
        if (maxPerDay > 0 && g.slots.length > maxPerDay) {
          count += g.slots.length - maxPerDay;
          if (details.length < 25) details.push(`${g.batch} ${g.day}: ${g.slots.length} labs (max ${maxPerDay})`);
        }
      }
      return { count, details };
    },
  };

  const fg = rc.facultyGaps;
  const S3 = {
    id: 'S3_MINIMIZE_FACULTY_GAPS', type: 'soft', scope: 'faculty', enabled: !!fg.enabled, weight: w(fg), config: fg,
    description: 'Minimise idle slots between a faculty member\'s first and last class of each day (counted in gap-hours).',
    check(c, asg) {
      const g = new Map();
      for (const it of asg) {
        const k = `${keyFac(it)}#${it.day}`;
        if (!g.has(k)) g.set(k, { f: it.faculty, day: it.day, s: new Set() });
        g.get(k).s.add(it.slot);
      }
      let count = 0;
      const details = [];
      for (const e of g.values()) {
        const arr = [...e.s];
        const gap = Math.max(...arr) - Math.min(...arr) + 1 - arr.length;
        if (gap > 0) { count += gap; if (details.length < 25) details.push(`${e.f} ${e.day}: ${gap} idle slot(s) between classes`); }
      }
      return { count, details };
    },
  };

  const ps = rc.preferredSlots;
  const prefs = (ps.prefs || []).map((p) => ({ kind: p.kind, key: normName(p.name), name: p.name, slots: new Set(p.slots) }));
  const S4 = {
    id: 'S4_PREFERRED_SLOTS', type: 'soft', scope: 'batch/faculty/subject', enabled: !!ps.enabled, weight: w(ps), config: ps,
    description: 'Prefer configured time slots per batch, faculty or subject (penalty per class outside its preferred slots).',
    check(c, asg) {
      let count = 0;
      const details = [];
      for (const it of asg) {
        for (const p of prefs) {
          const hit = p.kind === 'batch' ? keyBat(it) === p.key : p.kind === 'faculty' ? keyFac(it) === p.key : keySub(it) === p.key;
          if (hit && !p.slots.has(it.slot)) { count++; if (details.length < 25) details.push(`${it.batch} · ${it.subject} on ${it.day} slot ${it.slot + 1} (${p.kind} ${p.name} prefers ${[...p.slots].map((s) => s + 1).join(',')})`); }
        }
      }
      return { count, details };
    },
  };

  const hard = [H1, H2, H3, H4, H5, H6];
  const soft = [S1, S2, S3, S4];
  return { hard, soft, all: [...hard, ...soft], byId: Object.fromEntries([...hard, ...soft].map((r) => [r.id, r])), H: { H1, H2, H3, H4, H5, H6 } };
}

/** Plain-data description of a rule set (safe to send across a Worker boundary / render in the UI). */
export function describeRules(rules) {
  return rules.all.map((r) => ({
    id: r.id, type: r.type, scope: r.scope, description: r.description,
    weight: r.type === 'hard' ? 'inviolable' : r.weight, enabled: r.enabled,
  }));
}

// ============================================================================
// 4. AUDITOR + SOFT COST
// ============================================================================

/** Evaluate every HARD rule on a finished timetable. Counts are per rule; isValid only if all are 0. */
export function auditSolution(ctx, rules, assignment) {
  const perRule = rules.hard.map((r) => {
    const res = r.check(ctx, assignment);
    return { id: r.id, description: r.description, scope: r.scope, violations: res.count, details: res.details };
  });
  const hours = rules.H.H5.check(ctx, assignment).table;
  const byId = Object.fromEntries(perRule.map((p) => [p.id, p.violations]));
  const total = perRule.reduce((s, p) => s + p.violations, 0);
  return {
    perRule, hours, totalViolations: total, isValid: total === 0,
    facultyCollisions: byId.H1_FACULTY_CLASH, roomCollisions: byId.H2_ROOM_CLASH, batchCollisions: byId.H3_BATCH_CLASH,
    roomTypeMismatches: byId.H4_ROOM_TYPE, hoursMismatches: byId.H5_WEEKLY_HOURS, gridViolations: byId.H6_GRID_AVAILABILITY,
  };
}

/** Evaluate soft rules. cost = Σ weight × count over ENABLED rules. Counts are reported for all soft rules. */
export function softReport(ctx, rules, assignment) {
  let cost = 0;
  const perRule = rules.soft.map((r) => {
    const res = r.check(ctx, assignment);
    const weighted = r.enabled ? r.weight * res.count : 0;
    cost += weighted;
    return { id: r.id, description: r.description, enabled: r.enabled, weight: r.weight, violations: res.count, weighted, details: res.details };
  });
  return { perRule, cost };
}

const softCostFast = (ctx, activeSoft, asg) => {
  let c = 0;
  for (const r of activeSoft) c += r.weight * r.check(ctx, asg).count;
  return c;
};

export function summarizeConstraints(audit, soft) {
  const hardTotal = audit.perRule.length;
  const hardOk = audit.perRule.filter((p) => p.violations === 0).length;
  const act = soft.perRule.filter((p) => p.enabled);
  const softOk = act.filter((p) => p.violations === 0).length;
  const pct = (a, b) => (b === 0 ? 100 : Math.round((a / b) * 1000) / 10);
  return {
    hard: { rules: hardTotal, satisfied: hardOk, percent: pct(hardOk, hardTotal), violations: audit.totalViolations },
    soft: { rules: act.length, satisfied: softOk, percent: pct(softOk, act.length), violations: act.reduce((s, p) => s + p.violations, 0) },
  };
}

// ============================================================================
// 5. PRE-FLIGHT FEASIBILITY ANALYSIS (problem reduction by counting arguments)
// ============================================================================

/** Returns {ok, issues:[{code, message}]}. Any issue is a PROOF of infeasibility (no search needed). */
export function preflight(ctx) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const { T, D, S, workload } = ctx;
  const grid = `${D} day${D === 1 ? '' : 's'} × ${S} slot${S === 1 ? '' : 's'} = ${T} slots`;
  const theoryHours = workload.filter((r) => !r.isLab).reduce((s, r) => s + r.weeklyHours, 0);
  const labHours = workload.filter((r) => r.isLab).reduce((s, r) => s + r.weeklyHours, 0);

  if (theoryHours > 0 && ctx.theory.length === 0) add('NO_THEORY_ROOMS', `No theory rooms are configured but ${theoryHours} theory hour(s) must be scheduled.`);
  if (labHours > 0 && ctx.lab.length === 0) {
    const subs = [...new Set(workload.filter((r) => r.isLab).map((r) => r.subject))].slice(0, 5).join(', ');
    add('NO_LAB_ROOMS', `No lab rooms are configured but ${labHours} lab hour(s) must be scheduled (${subs}).`);
  }

  for (const r of workload) {
    if (r.weeklyHours > T) add('SUBJECT_HOURS_EXCEED_GRID', `${r.batch} / ${r.subject} needs ${r.weeklyHours}h but the grid has only ${T} slots (${grid}); sessions of one subject need distinct slots.`);
  }

  const group = (keyFn, nameFn) => {
    const m = new Map();
    for (const r of workload) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, { name: nameFn(r), hours: 0 });
      m.get(k).hours += r.weeklyHours;
    }
    return m;
  };
  const facLoad = group((r) => normName(r.faculty), (r) => r.faculty);
  const batLoad = group((r) => normName(r.batch), (r) => r.batch);
  const avail = (map, key) => T - (map.get(key) ? map.get(key).size : 0);

  for (const [k, e] of facLoad) {
    const a = avail(ctx.unavailable.faculty, k);
    if (e.hours > 0 && a === 0) add('FACULTY_NEVER_AVAILABLE', `Faculty "${e.name}" is unavailable in every slot but has ${e.hours}h to teach.`);
    else if (e.hours > a) add('FACULTY_OVERLOAD', `Faculty "${e.name}" is assigned ${e.hours} weekly hours but has only ${a} available slot(s) (${grid}${a < T ? `, ${T - a} marked unavailable` : ''}).`);
  }
  for (const [k, e] of batLoad) {
    const a = avail(ctx.unavailable.batch, k);
    if (e.hours > 0 && a === 0) add('BATCH_NEVER_AVAILABLE', `Batch "${e.name}" is unavailable in every slot but has ${e.hours}h of classes.`);
    else if (e.hours > a) add('BATCH_OVERLOAD', `Batch "${e.name}" has ${e.hours} weekly hours but only ${a} available slot(s) (${grid}${a < T ? `, ${T - a} marked unavailable` : ''}).`);
  }

  // A subject's sessions need distinct slots where BOTH its faculty and its batch are free.
  for (const r of workload) {
    const f = ctx.unavailable.faculty.get(normName(r.faculty));
    const b = ctx.unavailable.batch.get(normName(r.batch));
    let free = 0;
    for (let t = 0; t < T; t++) if (!(f && f.has(t)) && !(b && b.has(t))) free++;
    if (r.weeklyHours <= T && r.weeklyHours > free && free > 0) add('SUBJECT_NO_COMMON_SLOTS', `${r.batch} / ${r.subject} needs ${r.weeklyHours}h but ${r.faculty} and the batch share only ${free} free slot(s).`);
  }

  if (ctx.theory.length > 0 && theoryHours > ctx.theory.length * T) add('THEORY_CAPACITY', `Total theory hours (${theoryHours}) exceed theory room capacity: ${ctx.theory.length} room(s) × ${T} slots = ${ctx.theory.length * T}.`);
  if (ctx.lab.length > 0 && labHours > ctx.lab.length * T) add('LAB_CAPACITY', `Total lab hours (${labHours}) exceed lab room capacity: ${ctx.lab.length} room(s) × ${T} slots = ${ctx.lab.length * T}.`);

  return { ok: issues.length === 0, issues };
}

// ============================================================================
// 6. CSP SOLVER
// ============================================================================
// AI techniques that actually run here:
//  * Problem reduction : weekly hours → unit sessions; unary filtering of domains (room type, availability);
//                        symmetry breaking (sessions of one subject are forced into increasing time order).
//  * Constraint propagation : AC-3 at the root (and optionally after every assignment, `mac`) + forward checking.
//  * Heuristics : MRV, degree tie-break, least-constraining-value (counted from neighbours' live domains),
//                 soft-cost delta as final tie-break (never favours slot 1 when avoidance is on).
//  * Backtracking with a TRAIL (undo stack): domains are sparse sets; removals are logged and undone in LIFO order.
//
// Value encoding: code = t * R + roomIndex, with t = dayIndex * S + slot.
//
// Metric definitions
//   nodes      = number of recursive search calls (one per attempted variable selection).
//   backtracks = number of tentative assignments that were UNDONE without leading to a solution (including those
//                rejected at once by a forward-checking wipeout). Each failed branch is counted exactly once.
//   prune.*    = number of (variable, value) pairs removed by each stage.

export function solveCSP(ctx, rules, variables, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const { S, T, R } = ctx;
  const NC = T * R;
  const n = variables.length;
  const stats = { nodes: 0, backtracks: 0, prune: { unary: 0, symmetry: 0, ac3Root: 0, ac3Search: 0, forward: 0 } };
  const start = performance.now();
  const finish = (status, extra = {}) => ({ status, ...stats, prune: { ...stats.prune }, timeMs: performance.now() - start, ...extra });
  if (n === 0) return finish('solved', { assignment: [] });

  const { H1, H3, H4, H6 } = rules.H;
  const tOf = (c) => (c / R) | 0;
  const rOf = (c) => c % R;

  // --- domains as sparse sets with a trail ---------------------------------
  const dom = new Array(n);
  const where = new Array(n);
  const size = new Int32Array(n);
  const trail = [];
  const assigned = new Int32Array(n).fill(-1);

  // Unary reduction + symmetry bounds
  const itemOf = variables.map((v) => v.itemIndex);
  const groupSize = new Map();
  for (const v of variables) groupSize.set(v.itemIndex, (groupSize.get(v.itemIndex) || 0) + 1);
  for (let v = 0; v < n; v++) {
    const va = variables[v];
    const k = va.sessionIndex - 1;
    const m = groupSize.get(va.itemIndex);
    const codes = [];
    let unary = 0, sym = 0;
    for (let t = 0; t < T; t++) {
      const timeOk = H6.unary(va, t);
      for (let r = 0; r < R; r++) {
        if (!timeOk || !H4.unary(va, r)) { unary++; continue; }
        if (limits.symmetry && (t < k || t > T - 1 - (m - 1 - k))) { sym++; continue; }
        codes.push(t * R + r);
      }
    }
    stats.prune.unary += unary;
    stats.prune.symmetry += sym;
    dom[v] = Int32Array.from(codes);
    where[v] = new Int32Array(NC).fill(-1);
    for (let i = 0; i < codes.length; i++) where[v][codes[i]] = i;
    size[v] = codes.length;
  }

  const removeVal = (v, c) => {
    const w = where[v];
    const p = w[c];
    if (p < 0 || p >= size[v]) return false;
    const last = size[v] - 1;
    const d = dom[v];
    const lc = d[last];
    d[p] = lc; w[lc] = p;
    d[last] = c; w[c] = last;
    size[v]--;
    trail.push(v);
    return true;
  };
  const undoTo = (mark) => { while (trail.length > mark) size[trail.pop()]++; };
  const removeTime = (v, t) => { let k = 0; for (let r = 0; r < R; r++) if (removeVal(v, t * R + r)) k++; return k; };

  // --- constraint graph built from the rule keys ------------------------------
  const fk = variables.map((v) => H1.keyOf(v));
  const bk = variables.map((v) => H3.keyOf(v));
  const nbDiff = Array.from({ length: n }, () => []);   // same faculty or same batch -> different time
  const nbRoom = Array.from({ length: n }, () => []);   // same room pool -> not the same (time, room)
  const ordPrev = new Int32Array(n).fill(-1);
  const ordNext = new Int32Array(n).fill(-1);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (fk[a] === fk[b] || bk[a] === bk[b]) { nbDiff[a].push(b); nbDiff[b].push(a); }
      else if (variables[a].isLab === variables[b].isLab) { nbRoom[a].push(b); nbRoom[b].push(a); }
    }
    if (limits.symmetry && a + 1 < n && itemOf[a + 1] === itemOf[a]) { ordNext[a] = a + 1; ordPrev[a + 1] = a; }
  }

  // --- AC-3 ---------------------------------------------------------------------
  const summary = (w) => {
    if (assigned[w] >= 0) { const t = tOf(assigned[w]); return { size: 1, minT: t, maxT: t, onlyT: t, single: assigned[w] }; }
    let minT = Infinity, maxT = -1, onlyT = -2, single = -1;
    const d = dom[w];
    for (let i = 0; i < size[w]; i++) {
      const t = tOf(d[i]);
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      onlyT = onlyT === -2 ? t : onlyT === t ? t : -1;
    }
    if (size[w] === 1) single = d[0];
    return { size: size[w], minT, maxT, onlyT: onlyT === -2 ? -1 : onlyT, single };
  };

  /** Propagate from the given variables whose domains changed. Returns false on wipeout. */
  const propagate = (seeds, counter) => {
    const queue = [];
    const inQ = new Uint8Array(n);
    for (const s of seeds) if (!inQ[s]) { inQ[s] = 1; queue.push(s); }
    let head = 0;
    while (head < queue.length) {
      const w = queue[head++];
      inQ[w] = 0;
      const sm = summary(w);
      if (sm.size === 0) return false;
      const touched = (u, removed) => {
        stats.prune[counter] += removed;
        if (size[u] === 0) return false;
        if (removed > 0 && !inQ[u]) { inQ[u] = 1; queue.push(u); }
        return true;
      };
      for (const u of nbDiff[w]) {
        if (assigned[u] >= 0 || sm.onlyT < 0) continue;
        const removed = removeTime(u, sm.onlyT);
        if (!touched(u, removed)) return false;
      }
      for (const u of nbRoom[w]) {
        if (assigned[u] >= 0 || sm.size !== 1) continue;
        const removed = removeVal(u, sm.single) ? 1 : 0;
        if (!touched(u, removed)) return false;
      }
      // order constraint: ordPrev[w] must be earlier than w; ordNext[w] must be later than w
      const p = ordPrev[w];
      if (p >= 0 && assigned[p] < 0) {
        const kill = [];
        for (let i = 0; i < size[p]; i++) if (tOf(dom[p][i]) >= sm.maxT) kill.push(dom[p][i]);
        let removed = 0;
        for (const c of kill) if (removeVal(p, c)) removed++;
        if (!touched(p, removed)) return false;
      }
      const q = ordNext[w];
      if (q >= 0 && assigned[q] < 0) {
        const kill = [];
        for (let i = 0; i < size[q]; i++) if (tOf(dom[q][i]) <= sm.minT) kill.push(dom[q][i]);
        let removed = 0;
        for (const c of kill) if (removeVal(q, c)) removed++;
        if (!touched(q, removed)) return false;
      }
    }
    return true;
  };

  for (let v = 0; v < n; v++) {
    if (size[v] === 0) {
      const va = variables[v];
      return finish('proven_unsolvable', {
        diagnosis: [`${va.batch} / ${va.subject} (${va.faculty}) has no feasible (day, slot, room) left after unary reduction${va.isLab ? ' — check lab rooms/availability' : ''}.`],
      });
    }
  }
  const allVars = Array.from({ length: n }, (_, i) => i);
  if (!propagate(allVars, 'ac3Root')) {
    return finish('proven_unsolvable', { diagnosis: ['Arc consistency (AC-3) emptied a session\'s domain before any search: the clash constraints cannot all be met.'] });
  }
  trail.length = 0; // root reductions are permanent

  // --- soft-aware value ordering helpers ------------------------------------------
  const activeSoft = rules.soft.filter((r) => r.enabled && r.weight > 0);
  const subjDay = new Int32Array(Math.max(1, groupSize.size) * ctx.D);
  const makeItem = (v, c) => {
    const va = variables[v];
    const t = tOf(c);
    return { ...va, day: ctx.days[(t / S) | 0], slot: t % S, room: ctx.rooms[rOf(c)].name };
  };
  let partialCache = null; // per-node: {items, base}
  const partialFor = () => {
    if (partialCache) return partialCache;
    const items = [];
    for (let v = 0; v < n; v++) if (assigned[v] >= 0) items.push(makeItem(v, assigned[v]));
    partialCache = { items, base: softCostFast(ctx, activeSoft, items) };
    return partialCache;
  };
  const timeCost = new Int32Array(T);
  const codeCost = new Int32Array(NC);

  const orderedValues = (v) => {
    const live = Array.from(dom[v].subarray(0, size[v]));
    // least-constraining value: how many live values would this choice remove from unassigned neighbours?
    timeCost.fill(0); codeCost.fill(0);
    for (const w of nbDiff[v]) {
      if (assigned[w] >= 0) continue;
      for (let i = 0; i < size[w]; i++) timeCost[tOf(dom[w][i])]++;
    }
    for (const w of nbRoom[v]) {
      if (assigned[w] >= 0) continue;
      for (let i = 0; i < size[w]; i++) codeCost[dom[w][i]]++;
    }
    const lcv = (c) => timeCost[tOf(c)] + codeCost[c];
    const softCache = new Map();
    const softDelta = (c) => {
      if (activeSoft.length === 0) return 0;
      let d = softCache.get(c);
      if (d === undefined) {
        const p = partialFor();
        p.items.push(makeItem(v, c));
        d = softCostFast(ctx, activeSoft, p.items) - p.base;
        p.items.pop();
        softCache.set(c, d);
      }
      return d;
    };
    const spread = (c) => subjDay[itemOf[v] * ctx.D + ((tOf(c) / S) | 0)];
    live.sort((a, b) => lcv(a) - lcv(b) || softDelta(a) - softDelta(b) || spread(a) - spread(b) || a - b);
    return live;
  };

  const degree = (v) => {
    let d = 0;
    for (const w of nbDiff[v]) if (assigned[w] < 0) d++;
    return d;
  };

  // --- forward checking on assignment -----------------------------------------------
  const forwardCheck = (v, c) => {
    const t = tOf(c);
    for (const w of nbDiff[v]) {
      if (assigned[w] >= 0) continue;
      stats.prune.forward += removeTime(w, t);
      if (size[w] === 0) return false;
    }
    for (const w of nbRoom[v]) {
      if (assigned[w] >= 0) continue;
      if (removeVal(w, c)) stats.prune.forward++;
      if (size[w] === 0) return false;
    }
    const q = ordNext[v];
    if (q >= 0 && assigned[q] < 0) {
      const kill = [];
      for (let i = 0; i < size[q]; i++) if (tOf(dom[q][i]) <= t) kill.push(dom[q][i]);
      for (const x of kill) if (removeVal(q, x)) stats.prune.forward++;
      if (size[q] === 0) return false;
    }
    const p = ordPrev[v];
    if (p >= 0 && assigned[p] < 0) {
      const kill = [];
      for (let i = 0; i < size[p]; i++) if (tOf(dom[p][i]) >= t) kill.push(dom[p][i]);
      for (const x of kill) if (removeVal(p, x)) stats.prune.forward++;
      if (size[p] === 0) return false;
    }
    return true;
  };

  // --- search -------------------------------------------------------------------------
  let abort = null; // 'node' | 'time'
  const recurse = () => {
    stats.nodes++;
    if (stats.nodes > limits.maxNodes) { abort = 'node'; return false; }
    if ((stats.nodes & 31) === 1 && performance.now() - start >= limits.maxTimeMs) { abort = 'time'; return false; }

    // MRV with degree tie-break
    let best = -1, bestSize = Infinity, bestDeg = -1;
    for (let v = 0; v < n; v++) {
      if (assigned[v] >= 0) continue;
      const s = size[v];
      if (s === 0) return false;
      if (s < bestSize) { best = v; bestSize = s; bestDeg = -1; }
      else if (s === bestSize) {
        if (bestDeg < 0) bestDeg = degree(best);
        const d = degree(v);
        if (d > bestDeg) { best = v; bestDeg = d; }
      }
    }
    if (best < 0) return true;

    const v = best;
    partialCache = null;
    const values = orderedValues(v);
    for (const c of values) {
      const mark = trail.length;
      assigned[v] = c;
      let ok = forwardCheck(v, c);
      if (ok && limits.mac) {
        const changed = new Set();
        for (let i = mark; i < trail.length; i++) changed.add(trail[i]);
        ok = propagate(changed, 'ac3Search');
      }
      if (ok) {
        subjDay[itemOf[v] * ctx.D + ((tOf(c) / S) | 0)]++;
        const done = recurse();
        subjDay[itemOf[v] * ctx.D + ((tOf(c) / S) | 0)]--;
        if (done) return true;
      }
      undoTo(mark);
      assigned[v] = -1;
      if (abort) return false;
      stats.backtracks++;
    }
    return false;
  };

  const ok = recurse();
  if (ok) {
    const assignment = variables.map((va, i) => {
      const c = assigned[i];
      const t = tOf(c);
      return { ...va, day: ctx.days[(t / S) | 0], slot: t % S, room: ctx.rooms[rOf(c)].name };
    });
    return finish('solved', { assignment });
  }
  if (abort === 'node') return finish('aborted_node_limit');
  if (abort === 'time') return finish('aborted_time_limit');
  return finish('proven_unsolvable', { diagnosis: ['The search space was exhausted: no assignment satisfies all hard constraints.'] });
}

/** Fixed input-order, fixed time/room-order baseline searches. Partial states are checked
 * against the same declarative hard rules (H5 is checked only on complete schedules). */
export function generateBaselineTimetable(workload, config, algorithm = 'DFS', opts = {}) {
  const started = performance.now();
  const ctx = buildContext(config, workload);
  const base = { algorithm, assignment: null, nodes: 0, generatedStates: 0, backtracks: null, requiredSessions: 0 };
  const finish = (status, extra = {}) => ({ ...base, status, timeMs: performance.now() - started, ...extra });
  if (!ctx.ok) return finish('invalid_config', { reason: ctx.errors.join(' '), diagnosis: ctx.errors });
  if (!workload?.length) return finish('invalid_input', { reason: 'The workload is empty.', diagnosis: ['The workload is empty.'] });
  const maxH = maxHoursForGrid(ctx.D, ctx.S);
  const bad = ctx.workload.filter(r => !Number.isInteger(r.weeklyHours) || r.weeklyHours < 1 || r.weeklyHours > maxH);
  if (bad.length) return finish('invalid_input', { reason: `${bad[0].batch} / ${bad[0].subject}: invalid weekly hours.`, diagnosis: ['Correct workload hours before scheduling.'] });
  const pf = preflight(ctx);
  if (!pf.ok) return finish('proven_unsolvable', { reason: pf.issues[0].message, diagnosis: pf.issues.map(i => i.message), requiredSessions: expandWorkloadToVariables(workload).length });
  const variables = expandWorkloadToVariables(workload), rules = buildRules(ctx), n = variables.length;
  const requiredSessions = n, R = ctx.R, T = ctx.T;
  const maxNodes = Math.max(1, Number(opts.maxNodes) || 40000);
  const maxTimeMs = Math.max(0, Number(opts.maxTimeMs ?? 4000));
  const maxQueue = Math.max(1, Number(opts.maxQueue) || 20000);
  const candidate = (v, code) => {
    const t = Math.floor(code / R), room = code % R;
    return { ...variables[v], day: ctx.days[Math.floor(t / ctx.S)], slot: t % ctx.S, room: ctx.rooms[room].name };
  };
  const viable = (items) => rules.hard.every(r => r.id === 'H5_WEEKLY_HOURS' || r.check(ctx, items).count === 0);
  const partialViolationCount = (items) => rules.hard.filter(r => r.id !== 'H5_WEEKLY_HOURS').reduce((sum, r) => sum + r.check(ctx, items).count, 0);
  const completeResult = (items) => {
    const audit = auditSolution(ctx, rules, items), soft = softReport(ctx, rules, items);
    return { assignment: items, audit, softAfter: soft, softBefore: soft, solutionFound: true,
      complete: items.length === requiredSessions, valid: audit.isValid, hardViolations: audit.totalViolations, softPenalty: soft.cost };
  };
  const domains = variables.map(v => {
    const out = [];
    for (let t = 0; t < T; t++) for (let r = 0; r < R; r++) if (rules.H.H4.unary(v, r) && rules.H.H6.unary(v, t)) out.push(t * R + r);
    return out;
  });
  let status = 'proven_unsolvable', reason = 'Search space exhausted: no timetable satisfies all hard constraints.';
  if (String(algorithm).toUpperCase() === 'DFS') {
    const chosen = new Array(n); let stop = null;
    base.backtracks = 0;
    const visit = (depth) => {
      base.nodes++;
      if (base.nodes > maxNodes) { stop = 'aborted_node_limit'; return false; }
      if ((base.nodes & 31) === 1 && performance.now() - started >= maxTimeMs) { stop = 'aborted_time_limit'; return false; }
      if (depth === n) return true;
      for (const code of domains[depth]) {
        const item = candidate(depth, code), partial = chosen.slice(0, depth).concat(item);
        base.generatedStates++;
        if (!viable(partial)) { base.backtracks++; continue; }
        chosen[depth] = item;
        if (visit(depth + 1)) return true;
        if (stop) return false;
        base.backtracks++;
      }
      return false;
    };
    if (visit(0)) return finish('solved', { ...completeResult(chosen.slice()), requiredSessions, searchStatus: 'first_solution', reason: 'DFS found the first complete valid schedule in fixed input and candidate order.' });
    if (stop) { status = stop; reason = stop === 'aborted_node_limit' ? `DFS reached its ${maxNodes} node limit; the search is inconclusive.` : `DFS reached its ${maxTimeMs} ms time limit; the search is inconclusive.`; }
  } else if (String(algorithm).toUpperCase() === 'BFS') {
    const queue = [{ depth: 0, items: [] }]; let head = 0, bestPartial = [];
    while (head < queue.length) {
      if (base.nodes >= maxNodes) { status = 'aborted_node_limit'; reason = `BFS reached its ${maxNodes} expanded-state limit; the search is inconclusive.`; break; }
      if ((base.nodes & 31) === 0 && performance.now() - started >= maxTimeMs) { status = 'aborted_time_limit'; reason = `BFS reached its ${maxTimeMs} ms time limit; the search is inconclusive.`; break; }
      const state = queue[head++]; base.nodes++;
      if (state.depth > bestPartial.length) bestPartial = state.items;
      if (state.depth === n) return finish('solved', { ...completeResult(state.items), requiredSessions, searchStatus: 'first_solution', reason: 'BFS found the first complete valid schedule using FIFO level-order expansion.' });
      for (const code of domains[state.depth]) {
        if (queue.length - head >= maxQueue) { status = 'aborted_state_limit'; reason = `BFS reached its ${maxQueue} queued-state memory limit; the search is inconclusive.`; break; }
        const items = state.items.concat(candidate(state.depth, code)); base.generatedStates++;
        if (!viable(items)) continue;
        queue.push({ depth: state.depth + 1, items });
      }
      if (status === 'aborted_state_limit') break;
    }
    if (status === 'proven_unsolvable' && head >= queue.length) reason = 'BFS exhausted the reachable search space: no timetable satisfies all hard constraints.';
    if (bestPartial.length) return finish(status, { reason, assignment: bestPartial, solutionFound: false, complete: false, valid: false, hardViolations: partialViolationCount(bestPartial), softPenalty: softReport(ctx, rules, bestPartial).cost, requiredSessions, searchStatus: status });
  } else return finish('invalid_input', { reason: `Unknown algorithm: ${algorithm}.`, diagnosis: ['Choose DFS or BFS.'] });
  return finish(status, { reason, diagnosis: [reason], requiredSessions, solutionFound: false, complete: false, valid: false, hardViolations: 0, softPenalty: null, searchStatus: status });
}

// ============================================================================
// 7. OPTIMIZER (simulated annealing, hard-constraint-preserving moves)
// ============================================================================

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Improve soft cost without ever violating a hard constraint.
 * Occupancy maps (faculty/batch/room × time) are updated incrementally; a move is only applied if the target
 * (time, room) is free for the batch, faculty and room, and allowed by the unary rules.
 * Moves: relocate one session to a free (day, slot, room); swap the placements of two same-type sessions.
 * The best timetable seen is returned (never worse than the input). The caller re-audits independently.
 */
export function optimizeTimetable(ctx, rules, assignment, opts = {}) {
  const o = { ...DEFAULT_OPTIMIZER, ...opts };
  const activeSoft = rules.soft.filter((r) => r.enabled && r.weight > 0);
  const startedAt = performance.now();
  const base = { initialCost: softCostFast(ctx, activeSoft, assignment), finalCost: 0, iterations: 0, accepted: 0, moves: 0, swaps: 0, infeasibleProposals: 0, adjustments: [], improved: false, seed: o.seed };
  const n = assignment.length;
  if (!o.enabled) return { ...base, finalCost: base.initialCost, assignment, note: 'Optimizer disabled.' };
  if (activeSoft.length === 0) return { ...base, finalCost: base.initialCost, assignment, note: 'No soft constraint is enabled with weight > 0, so there is nothing to optimize.' };
  if (base.initialCost === 0) return { ...base, assignment, note: 'The timetable already has soft cost 0; no improvement is possible.' };

  const { T, S, R } = ctx;
  const ids = (key) => { const m = new Map(); return (k) => { if (!m.has(k)) m.set(k, m.size); return m.get(k); }; };
  const fId = ids(), bId = ids();
  const items = assignment.map((it) => ({ ...it }));
  const fi = items.map((it) => fId(keyFac(it)));
  const bi = items.map((it) => bId(keyBat(it)));
  const t = items.map((it) => timeOf(ctx, it));
  const r = items.map((it) => ctx.roomIndex.get(keyRoom(it)));
  const fac = new Map(), bat = new Map(), roomOcc = new Map();
  const K = (a, b) => a * (T + 1) + b;
  for (let i = 0; i < n; i++) { fac.set(K(fi[i], t[i]), i); bat.set(K(bi[i], t[i]), i); roomOcc.set(K(r[i], t[i]), i); }

  const unaryOk = (i, tt, rr) => rules.H.H4.unary(items[i], rr) && rules.H.H6.unary(items[i], tt);
  const place = (i, tt, rr) => {
    t[i] = tt; r[i] = rr;
    items[i].day = ctx.days[(tt / S) | 0]; items[i].slot = tt % S; items[i].room = ctx.rooms[rr].name;
    fac.set(K(fi[i], tt), i); bat.set(K(bi[i], tt), i); roomOcc.set(K(rr, tt), i);
  };
  const lift = (i) => { fac.delete(K(fi[i], t[i])); bat.delete(K(bi[i], t[i])); roomOcc.delete(K(r[i], t[i])); };
  const free = (i, tt, rr) => !fac.has(K(fi[i], tt)) && !bat.has(K(bi[i], tt)) && !roomOcc.has(K(rr, tt));

  const rng = mulberry32(o.seed);
  let cost = base.initialCost;
  let bestCost = cost;
  let bestT = t.slice(), bestR = r.slice();
  const T0 = Math.max(1, ...activeSoft.map((x) => x.weight)) * 1.5;
  const T1 = 0.05;
  const stats = { accepted: 0, moves: 0, swaps: 0, infeasibleProposals: 0 };
  let it = 0;

  for (; it < o.maxIterations; it++) {
    if ((it & 63) === 0 && performance.now() - startedAt > o.maxTimeMs) break;
    const temp = T0 * Math.pow(T1 / T0, it / o.maxIterations);
    const i = (rng() * n) | 0;
    const doSwap = rng() < 0.4;
    let undo = null;
    if (!doSwap) {
      const tt = (rng() * T) | 0;
      const rr = (rng() * R) | 0;
      if ((tt === t[i] && rr === r[i]) || !unaryOk(i, tt, rr)) { stats.infeasibleProposals++; continue; }
      const ot = t[i], orr = r[i];
      lift(i);
      if (!free(i, tt, rr)) { place(i, ot, orr); stats.infeasibleProposals++; continue; }
      place(i, tt, rr);
      undo = () => { lift(i); place(i, ot, orr); };
    } else {
      const j = (rng() * n) | 0;
      if (j === i || items[i].isLab !== items[j].isLab || (t[i] === t[j] && r[i] === r[j])) { stats.infeasibleProposals++; continue; }
      const ti = t[i], ri = r[i], tj = t[j], rj = r[j];
      if (!unaryOk(i, tj, rj) || !unaryOk(j, ti, ri)) { stats.infeasibleProposals++; continue; }
      lift(i); lift(j);
      if (!free(i, tj, rj)) { place(i, ti, ri); place(j, tj, rj); stats.infeasibleProposals++; continue; }
      place(i, tj, rj);
      if (!free(j, ti, ri)) { lift(i); place(i, ti, ri); place(j, tj, rj); stats.infeasibleProposals++; continue; }
      place(j, ti, ri);
      undo = () => { lift(i); lift(j); place(i, ti, ri); place(j, tj, rj); };
    }
    const nc = softCostFast(ctx, activeSoft, items);
    const delta = nc - cost;
    if (delta < -1e-9 || (delta > 1e-9 && rng() < Math.exp(-delta / temp))) {
      cost = nc;
      stats.accepted++;
      if (doSwap) stats.swaps++; else stats.moves++;
      if (cost < bestCost - 1e-9) { bestCost = cost; bestT = t.slice(); bestR = r.slice(); }
    } else undo();
  }

  // Minimal-change pass: reload the best state, then send each displaced session back to its ORIGINAL
  // placement whenever that spot is free and the cost does not rise. Fewer needless adjustments, same hard safety.
  for (let i = 0; i < n; i++) lift(i);
  for (let i = 0; i < n; i++) place(i, bestT[i], bestR[i]);
  const origT = assignment.map((a) => timeOf(ctx, a));
  const origR = assignment.map((a) => ctx.roomIndex.get(keyRoom(a)));
  let curCost = bestCost;
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (t[i] === origT[i] && r[i] === origR[i]) continue;
      const ct = t[i], cr = r[i];
      lift(i);
      if (free(i, origT[i], origR[i])) {
        place(i, origT[i], origR[i]);
        const nc = softCostFast(ctx, activeSoft, items);
        if (nc <= curCost + 1e-9) { curCost = nc; changed = true; continue; }
        lift(i);
      }
      place(i, ct, cr);
    }
    if (!changed) break;
  }
  bestT = t.slice(); bestR = r.slice();

  // Materialise the best timetable seen and list the NET adjustments versus the input.
  const finalItems = assignment.map((orig, i) => {
    const tt = bestT[i], rr = bestR[i];
    return { ...orig, day: ctx.days[(tt / S) | 0], slot: tt % S, room: ctx.rooms[rr].name };
  });
  const adjustments = [];
  finalItems.forEach((f, i) => {
    const o0 = assignment[i];
    if (f.day !== o0.day || f.slot !== o0.slot || f.room !== o0.room) {
      adjustments.push({
        session: `${o0.batch} · ${o0.subject} #${o0.sessionIndex}`, batch: o0.batch, subject: o0.subject, sessionIndex: o0.sessionIndex,
        from: { day: o0.day, slot: o0.slot, room: o0.room }, to: { day: f.day, slot: f.slot, room: f.room },
      });
    }
  });
  const finalCost = softCostFast(ctx, activeSoft, finalItems);
  const improved = finalCost < base.initialCost - 1e-9;
  return {
    ...base, ...stats, iterations: it, finalCost: improved ? finalCost : base.initialCost,
    assignment: improved ? finalItems : assignment, adjustments: improved ? adjustments : [], improved,
    timeMs: performance.now() - startedAt,
    note: improved ? `Cost reduced from ${base.initialCost} to ${finalCost}.` : 'The optimizer could not find a timetable with lower soft cost; the original is kept.',
  };
}

// ============================================================================
// 8. PIPELINE
// ============================================================================

/**
 * Full run: validate → pre-flight → CSP → audit → optimize → audit → report.
 * status ∈ solved | proven_unsolvable | aborted_node_limit | aborted_time_limit | invalid_config | invalid_input | audit_failed
 */
export function generateTimetable(workload, config, options = {}) {
  const t0 = performance.now();
  const ctx = buildContext(config, workload);
  const empty = { assignment: null, nodes: 0, backtracks: 0, prune: { unary: 0, symmetry: 0, ac3Root: 0, ac3Search: 0, forward: 0 }, diagnosis: [], requiredSessions: 0 };
  if (!ctx.ok) return { ...empty, status: 'invalid_config', reason: ctx.errors.join(' '), diagnosis: ctx.errors, timeMs: performance.now() - t0 };
  const rules = buildRules(ctx);
  const rulesInfo = describeRules(rules);
  const done = (r) => ({ ...empty, rules: rulesInfo, timeMs: performance.now() - t0, ...r });

  if (!workload || workload.length === 0) return done({ status: 'invalid_input', reason: 'The workload is empty.', diagnosis: ['The workload is empty.'] });
  const maxH = maxHoursForGrid(ctx.D, ctx.S);
  const badRows = ctx.workload.filter((r) => !Number.isInteger(r.weeklyHours) || r.weeklyHours < 1 || r.weeklyHours > maxH);
  if (badRows.length) {
    const diag = badRows.map((r) => `${r.batch} / ${r.subject}: Weekly_Hours ${r.weeklyHours} is invalid (allowed 1–${maxH} for this grid).`);
    return done({ status: 'invalid_input', reason: diag[0], diagnosis: diag });
  }
  const variables = expandWorkloadToVariables(workload);
  const requiredSessions = variables.length;

  const pf = preflight(ctx);
  if (!pf.ok) {
    return done({ status: 'proven_unsolvable', phase: 'preflight', reason: pf.issues[0].message, diagnosis: pf.issues.map((i) => i.message), issues: pf.issues, requiredSessions });
  }

  const res = solveCSP(ctx, rules, variables, options.limits || {});
  if (res.status !== 'solved') {
    const reasons = {
      proven_unsolvable: 'Search space exhausted: no timetable satisfies all hard constraints.',
      aborted_node_limit: `Search stopped at the node limit (${(options.limits?.maxNodes ?? DEFAULT_LIMITS.maxNodes).toLocaleString()} nodes). This is NOT a proof of infeasibility — a solution may exist.`,
      aborted_time_limit: `Search stopped at the time limit (${options.limits?.maxTimeMs ?? DEFAULT_LIMITS.maxTimeMs} ms). This is NOT a proof of infeasibility — a solution may exist.`,
    };
    return done({
      status: res.status, phase: 'search', reason: reasons[res.status], diagnosis: res.diagnosis || [reasons[res.status]],
      nodes: res.nodes, backtracks: res.backtracks, prune: res.prune, requiredSessions, solveTimeMs: res.timeMs,
    });
  }

  const initial = res.assignment;
  const auditBefore = auditSolution(ctx, rules, initial);
  const softBefore = softReport(ctx, rules, initial);
  const opt = optimizeTimetable(ctx, rules, initial, options.optimizer || {});
  let finalAssignment = opt.assignment;
  let audit = auditSolution(ctx, rules, finalAssignment);
  let optimizerReverted = false;
  if (!audit.isValid && auditBefore.isValid) {
    // Safety net: an optimizer result that fails the audit is discarded.
    finalAssignment = initial; audit = auditBefore; optimizerReverted = true;
    opt.adjustments = []; opt.improved = false; opt.note = 'Optimizer output failed the hard-constraint audit and was discarded.';
  }
  const softAfter = softReport(ctx, rules, finalAssignment);
  const status = audit.isValid ? 'solved' : 'audit_failed';
  return done({
    status, phase: 'search',
    reason: audit.isValid ? 'Timetable found and verified by the hard-constraint audit.' : 'The solver returned a timetable but the audit found hard-constraint violations.',
    assignment: finalAssignment, initialAssignment: initial,
    nodes: res.nodes, backtracks: res.backtracks, prune: res.prune, requiredSessions, solveTimeMs: res.timeMs,
    audit, auditBefore, softBefore, softAfter,
    optimizer: {
      enabled: opt.note !== 'Optimizer disabled.', improved: opt.improved, note: opt.note, seed: opt.seed, iterations: opt.iterations,
      acceptedMoves: opt.accepted, moves: opt.moves, swaps: opt.swaps, infeasibleProposals: opt.infeasibleProposals,
      adjustments: opt.adjustments, adjustmentCount: opt.adjustments.length, initialCost: opt.initialCost, finalCost: opt.finalCost,
      timeMs: opt.timeMs || 0, reverted: optimizerReverted,
    },
    summary: summarizeConstraints(audit, softAfter),
    summaryBefore: summarizeConstraints(auditBefore, softBefore),
  });
}
