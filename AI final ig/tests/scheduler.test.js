import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as S from '../scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const SAMPLE_CSV = html.match(/DEFAULT_CSV = `([^`]*)`/)[1];

const DAYS5 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const cfg = (o = {}) => ({ workingDays: DAYS5, slotsPerDay: 6, theoryRooms: ['TR-101', 'TR-102', 'TR-103', 'TR-104'], labRooms: ['LAB-A', 'LAB-B', 'CS-LAB'], ...o });
const row = (batch, subject, faculty, isLab, weeklyHours) => ({ batch, subject, faculty, isLab, weeklyHours });
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// ---- independent recount helpers (do NOT use scheduler.js's auditor) -------------------
function independentCheck(asg, workload, c) {
  const bad = { faculty: 0, room: 0, batch: 0, roomType: 0, hours: 0 };
  const f = new Set(), r = new Set(), b = new Set();
  const labRooms = new Set(c.labRooms.map(norm)), theoryRooms = new Set(c.theoryRooms.map(norm));
  for (const a of asg) {
    const fk = `${norm(a.faculty)}|${a.day}|${a.slot}`, rk = `${norm(a.room)}|${a.day}|${a.slot}`, bk = `${norm(a.batch)}|${a.day}|${a.slot}`;
    if (f.has(fk)) bad.faculty++; f.add(fk);
    if (r.has(rk)) bad.room++; r.add(rk);
    if (b.has(bk)) bad.batch++; b.add(bk);
    if (a.isLab ? !labRooms.has(norm(a.room)) : !theoryRooms.has(norm(a.room))) bad.roomType++;
  }
  for (const w of workload) {
    const n = asg.filter((a) => norm(a.batch) === norm(w.batch) && norm(a.subject) === norm(w.subject)).length;
    if (n !== w.weeklyHours) bad.hours++;
  }
  return bad;
}
const allZero = (bad) => Object.values(bad).every((v) => v === 0);

function independentGaps(asg) {
  const m = new Map();
  for (const a of asg) { const k = `${norm(a.faculty)}|${a.day}`; (m.get(k) || m.set(k, []).get(k)).push(a.slot); }
  let g = 0;
  for (const s of m.values()) g += Math.max(...s) - Math.min(...s) + 1 - new Set(s).size;
  return g;
}
function independentConsecLabs(asg) {
  let c = 0;
  const labs = asg.filter((a) => a.isLab);
  for (const a of labs) for (const b of labs) if (a !== b && norm(a.batch) === norm(b.batch) && a.day === b.day && b.slot === a.slot + 1) c++;
  return c;
}
const independentFirstHour = (asg, batch) => asg.filter((a) => a.slot === 0 && norm(a.batch) === norm(batch)).length;

// ---- naive exhaustive solver for cross-checking -----------------------------------------------------
// Independent model: assign each unit session a TIME only. Rooms of one type are interchangeable, so a
// timetable exists iff, at every time, sessions of each type <= number of rooms of that type.
// No heuristics, no propagation, no symmetry breaking, no shared code with scheduler.js.
function bruteForceSolvable(workload, c, cap = 5e6) {
  const vars = [];
  workload.forEach((w) => { for (let h = 0; h < w.weeklyHours; h++) vars.push(w); });
  const times = c.workingDays.length * c.slotsPerDay;
  const F = new Set(), B = new Set();
  const cnt = new Map();
  const capOf = (lab) => (lab ? c.labRooms.length : c.theoryRooms.length);
  let nodes = 0;
  const go = (i) => {
    if (i === vars.length) return true;
    if (++nodes > cap) throw new Error('brute-force cap');
    const v = vars[i];
    for (let t = 0; t < times; t++) {
      const fk = `${norm(v.faculty)}#${t}`, bk = `${norm(v.batch)}#${t}`, ck = `${v.isLab}#${t}`;
      if (F.has(fk) || B.has(bk) || (cnt.get(ck) || 0) >= capOf(v.isLab)) continue;
      F.add(fk); B.add(bk); cnt.set(ck, (cnt.get(ck) || 0) + 1);
      if (go(i + 1)) return true;
      F.delete(fk); B.delete(bk); cnt.set(ck, cnt.get(ck) - 1);
    }
    return false;
  };
  return go(0);
}

// ====================================================================================
test('1. default sample CSV solves with zero violations and exact hours', () => {
  const { rows, errors } = S.parseCSV(SAMPLE_CSV, { maxHours: 30 });
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 16);
  assert.equal(rows.reduce((s, r) => s + r.weeklyHours, 0), 48);
  const c = cfg();
  const res = S.generateTimetable(rows, c);
  assert.equal(res.status, 'solved');
  assert.equal(res.assignment.length, 48);
  const bad = independentCheck(res.assignment, rows, c);
  assert.deepEqual(bad, { faculty: 0, room: 0, batch: 0, roomType: 0, hours: 0 });
  assert.equal(res.audit.isValid, true);
  assert.equal(res.audit.totalViolations, 0);
  for (const h of res.audit.hours) assert.equal(h.actual, h.required);
});

test('2. one faculty with 31h in 5x6 grid fails fast in pre-flight with a load message', () => {
  const rows = [row('A', 'S1', 'Prof X', false, 16), row('B', 'S2', 'Prof X', false, 15)];
  const res = S.generateTimetable(rows, cfg());
  assert.equal(res.status, 'proven_unsolvable');
  assert.equal(res.phase, 'preflight');
  assert.equal(res.nodes, 0);
  assert.match(res.reason, /Prof X.*31 weekly hours.*30/);
});

test('3. batch with 31h of subjects in 30 slots is diagnosed (not clamped)', () => {
  const rows = [row('A', 'S1', 'T1', false, 16), row('A', 'S2', 'T2', false, 15)];
  const res = S.generateTimetable(rows, cfg());
  assert.equal(res.status, 'proven_unsolvable');
  assert.equal(res.nodes, 0);
  assert.ok(res.diagnosis.some((d) => /Batch "A" has 31 weekly hours/.test(d)), res.diagnosis.join('|'));
});

test('4. invalid Weekly_Hours (12 on a small grid, 0, "abc") are reported and never changed', () => {
  const csv = 'Batch,Subject,Faculty_Name,Is_Lab,Weekly_Hours\nA,S1,T1,false,12\nA,S2,T2,false,0\nA,S3,T3,false,abc\nA,S4,T4,false,3\n';
  const max = S.maxHoursForGrid(2, 5); // 10
  const { rows, errors } = S.parseCSV(csv, { maxHours: max });
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((e) => e.row), [2, 3, 4]);
  assert.match(errors[0].message, /12 exceeds the maximum of 10/);
  assert.match(errors[1].message, /0 must be at least 1/);
  assert.match(errors[2].message, /"abc" is not a whole number/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weeklyHours, 3);
  // The maximum is configurable, not hardcoded 10:
  assert.equal(S.parseCSV(csv, { maxHours: 30 }).errors.length, 2);
  // Direct pipeline input is also validated against the grid, not clamped:
  const res = S.generateTimetable([row('A', 'S1', 'T1', false, 12)], cfg({ workingDays: ['Mon', 'Tue'], slotsPerDay: 5 }));
  assert.equal(res.status, 'invalid_input');
});

test('5. lab hours exceeding lab-room capacity names the lab capacity', () => {
  const rows = [row('A', 'L1', 'T1', true, 16), row('B', 'L2', 'T2', true, 15)];
  const res = S.generateTimetable(rows, cfg({ labRooms: ['LAB-A'] }));
  assert.equal(res.status, 'proven_unsolvable');
  assert.equal(res.phase, 'preflight');
  assert.ok(res.diagnosis.some((d) => /lab hours \(31\) exceed lab room capacity: 1 room\(s\) × 30 slots = 30/.test(d)), res.diagnosis.join('|'));
});

test('6. no lab rooms with lab subjects fails immediately; room in both lists is rejected', () => {
  const res = S.generateTimetable([row('A', 'L1', 'T1', true, 2)], cfg({ labRooms: [] }));
  assert.equal(res.status, 'proven_unsolvable');
  assert.equal(res.nodes, 0);
  assert.match(res.reason, /No lab rooms/);
  const res2 = S.generateTimetable([row('A', 'S1', 'T1', false, 2)], cfg({ theoryRooms: ['R1', 'R2'], labRooms: ['r2', 'LAB'] }));
  assert.equal(res2.status, 'invalid_config');
  assert.match(res2.reason, /both the theory and the lab/);
});

test('7. 3h of one teacher in a 1-day x 2-slot grid is proven unsolvable (exhausted), not aborted', () => {
  const c = cfg({ workingDays: ['Mon'], slotsPerDay: 2, theoryRooms: ['R1', 'R2', 'R3'], labRooms: ['L1'] });
  const rows = [row('A', 'a', 'T1', false, 1), row('B', 'b', 'T1', false, 1), row('C', 'c', 'T1', false, 1)];
  // (a) Search path, bypassing pre-flight: the solver itself must report exhaustion.
  const ctx = S.buildContext(c, rows);
  const direct = S.solveCSP(ctx, S.buildRules(ctx), S.expandWorkloadToVariables(ctx.workload));
  assert.equal(direct.status, 'proven_unsolvable');
  assert.ok(!direct.status.startsWith('aborted'));
  // (b) Full pipeline: caught earlier by the counting proof, with numbers.
  const pipe = S.generateTimetable(rows, c);
  assert.equal(pipe.status, 'proven_unsolvable');
  assert.equal(pipe.nodes, 0);
  assert.match(pipe.reason, /T1.*3 weekly hours.*2 available/);
});

test('8. hitting node/time limit gives aborted_*, never proven_unsolvable', () => {
  const { rows } = S.parseCSV(SAMPLE_CSV, { maxHours: 30 });
  const nodeLimited = S.generateTimetable(rows, cfg(), { limits: { maxNodes: 5 } });
  assert.equal(nodeLimited.status, 'aborted_node_limit');
  assert.equal(nodeLimited.assignment, null);
  assert.match(nodeLimited.reason, /NOT a proof/);
  const timeLimited = S.generateTimetable(rows, cfg(), { limits: { maxTimeMs: 0 } });
  assert.equal(timeLimited.status, 'aborted_time_limit');
  assert.doesNotMatch(timeLimited.reason, /exhausted/);
  // The same instance is solvable with the default limits (so "aborted" really means "unknown").
  assert.equal(S.generateTimetable(rows, cfg()).status, 'solved');
});

test('9. "Prof X" and "prof  x" are one person: never in the same slot', () => {
  const rows = [row('A', 'S1', 'Prof X', false, 5), row('B', 'S2', 'prof  x', false, 5), row('C', 'S3', ' PROF X ', false, 5)];
  const c = cfg({ workingDays: ['Mon', 'Tue'], slotsPerDay: 8, theoryRooms: ['R1', 'R2', 'R3'] });
  const res = S.generateTimetable(rows, c);
  assert.equal(res.status, 'solved');
  const seen = new Set();
  for (const a of res.assignment) {
    const k = `${a.day}|${a.slot}`;
    assert.ok(!seen.has(k), `faculty double-booked at ${k}`);
    seen.add(k);
  }
  assert.equal(new Set(res.assignment.map((a) => a.faculty)).size, 1, 'one display name');
  // 16 hours > 16 slots? 15h in 16 slots is fine; 17h must be rejected as a single person's overload:
  const over = S.generateTimetable([row('A', 'S1', 'Prof X', false, 9), row('B', 'S2', 'prof x', false, 8)], c);
  assert.equal(over.status, 'proven_unsolvable');
  assert.match(over.reason, /17 weekly hours/);
});

function seededInstance(rng) {
  const days = 2, slots = 3 + Math.floor(rng() * 2);
  const nb = 2 + Math.floor(rng() * 2);
  const teachers = ['T1', 't2', 'T3'];
  const rows = [];
  for (let b = 0; b < nb; b++) {
    const ns = 2 + Math.floor(rng() * 2);
    for (let s = 0; s < ns; s++) {
      rows.push(row(`B${b}`, `Sub${b}_${s}`, teachers[Math.floor(rng() * 3)], rng() < 0.3, 1 + Math.floor(rng() * 2)));
    }
  }
  const c = cfg({ workingDays: ['Mon', 'Tue'].slice(0, days), slotsPerDay: slots, theoryRooms: ['R1', 'R2'], labRooms: ['L1'] });
  return { rows, c };
}

test('10. randomized tight instances: every solution passes the audit; verdicts agree with brute force', () => {
  const rng = S.mulberry32(2024);
  let skippedBrute = 0, searchProved = 0, solved = 0, unsolvable = 0, withBacktracks = 0, checkedBrute = 0, mismatches = [];
  for (let i = 0; i < 400; i++) {
    const { rows, c } = seededInstance(rng);
    // merge accidental duplicate (batch,subject) not possible: names unique by construction
    const res = S.generateTimetable(rows, c, { optimizer: { enabled: false } });
    assert.ok(!res.status.startsWith('aborted'), `instance ${i} aborted`);
    assert.notEqual(res.status, 'invalid_config');
    if (res.status === 'solved') {
      solved++;
      assert.ok(allZero(independentCheck(res.assignment, rows, c)), `instance ${i} failed independent check`);
      assert.equal(res.audit.isValid, true);
      if (res.backtracks > 0) withBacktracks++;
    } else {
      assert.equal(res.status, 'proven_unsolvable');
      unsolvable++;
      if (res.phase === 'search') searchProved++;
    }
    const total = rows.reduce((s, r) => s + r.weeklyHours, 0);
    if (total <= 12) {
      let truth;
      try { truth = bruteForceSolvable(rows, c, 2e6); } catch { skippedBrute++; continue; }
      checkedBrute++;
      if (truth !== (res.status === 'solved')) mismatches.push(i);
    }
  }
  assert.deepEqual(mismatches, [], `verdict disagrees with brute force on instances ${mismatches}`);
  console.log(`  random: ${solved} solved, ${unsolvable} proven unsolvable (${searchProved} by exhaustive search, rest by pre-flight), ${withBacktracks} solved with backtracks>0, ${checkedBrute} cross-checked by brute force (${skippedBrute} skipped: oracle budget)`);
  assert.ok(solved > 50);
  assert.ok(checkedBrute > 100, 'enough instances cross-checked');
  assert.ok(withBacktracks > 0, 'at least some instances need real backtracking');
});

test('10b. MAC (AC-3 during search) and symmetry-off give the same verdicts', () => {
  const rng = S.mulberry32(77);
  for (let i = 0; i < 150; i++) {
    const { rows, c } = seededInstance(rng);
    const a = S.generateTimetable(rows, c, { optimizer: { enabled: false } });
    const b = S.generateTimetable(rows, c, { optimizer: { enabled: false }, limits: { mac: true } });
    const d = S.generateTimetable(rows, c, { optimizer: { enabled: false }, limits: { symmetry: false } });
    assert.equal(b.status, a.status, `mac differs on ${i}`);
    assert.equal(d.status, a.status, `symmetry-off differs on ${i}`);
    if (b.status === 'solved') assert.ok(allZero(independentCheck(b.assignment, rows, c)));
  }
});

test('11. soft constraints: optimizer lowers cost, keeps hard violations at 0, numbers match independent recount', () => {
  const { rows } = S.parseCSV(SAMPLE_CSV, { maxHours: 30 });
  const c = cfg({ rules: { firstHour: { enabled: true, weight: 5, batches: ['S5 CSE-A'] }, consecutiveLabs: { enabled: true, weight: 4, batches: ['all'] }, facultyGaps: { enabled: true, weight: 1 } } });
  // Compare against the raw CSP result (optimizer off) to measure real improvement.
  const raw = S.generateTimetable(rows, c, { optimizer: { enabled: false } });
  const opt = S.generateTimetable(rows, c, { optimizer: { enabled: true, seed: 7 } });
  assert.equal(opt.status, 'solved');
  assert.equal(opt.auditBefore.totalViolations, 0);
  assert.equal(opt.audit.totalViolations, 0);
  assert.ok(allZero(independentCheck(opt.assignment, rows, c)));
  assert.ok(opt.softAfter.cost <= opt.softBefore.cost);
  assert.equal(opt.softBefore.cost, raw.softBefore.cost, 'same CSP start (deterministic)');
  // Independent recount of the three counted constraints on BOTH timetables
  const rec = (asg) => ({ gaps: independentGaps(asg), consec: independentConsecLabs(asg), first: independentFirstHour(asg, 'S5 CSE-A') });
  const get = (rep, id) => rep.perRule.find((p) => p.id === id).violations;
  for (const [asg, rep] of [[opt.initialAssignment, opt.softBefore], [opt.assignment, opt.softAfter]]) {
    const r = rec(asg);
    assert.equal(get(rep, 'S3_MINIMIZE_FACULTY_GAPS'), r.gaps);
    assert.equal(get(rep, 'S2_AVOID_CONSECUTIVE_LABS'), r.consec);
    assert.equal(get(rep, 'S1_AVOID_FIRST_HOUR'), r.first);
    assert.equal(rep.cost, 5 * r.first + 4 * r.consec + 1 * r.gaps);
  }
  // Adjustment list is real: every listed session differs between before and after, and count matches.
  assert.equal(opt.optimizer.adjustmentCount, opt.optimizer.adjustments.length);
  const diff = opt.initialAssignment.filter((a, i) => { const b = opt.assignment[i]; return a.day !== b.day || a.slot !== b.slot || a.room !== b.room; }).length;
  assert.equal(diff, opt.optimizer.adjustmentCount);
  // Reproducible with the same seed
  const again = S.generateTimetable(rows, c, { optimizer: { enabled: true, seed: 7, maxTimeMs: 60000 } });
  const again2 = S.generateTimetable(rows, c, { optimizer: { enabled: true, seed: 7, maxTimeMs: 60000 } });
  assert.deepEqual(again.assignment, again2.assignment);
  console.log(`  soft cost before/after: ${opt.softBefore.cost} -> ${opt.softAfter.cost}, adjustments: ${opt.optimizer.adjustmentCount}`);
});

test('11b. first-hour avoidance: CSP ordering no longer prefers slot 1; optimizer reports honestly when it cannot improve', () => {
  const { rows } = S.parseCSV(SAMPLE_CSV, { maxHours: 30 });
  const c = cfg({ rules: { firstHour: { enabled: true, weight: 5, batches: ['all'] }, facultyGaps: { enabled: false }, preferredSlots: { enabled: false } } });
  const res = S.generateTimetable(rows, c, { optimizer: { enabled: false } });
  assert.equal(res.status, 'solved');
  assert.equal(independentFirstHour(res.assignment, 'S5 CSE-A') + independentFirstHour(res.assignment, 'S5 CSE-B') + independentFirstHour(res.assignment, 'S3 IT-A'), res.softBefore.perRule[0].violations);
  // No improvement possible case: everything already at cost 0
  const zero = S.generateTimetable(rows, cfg({ rules: { firstHour: { enabled: false }, facultyGaps: { enabled: false }, preferredSlots: { enabled: false } } }));
  assert.equal(zero.optimizer.improved, false);
  assert.equal(zero.optimizer.adjustmentCount, 0);
  assert.match(zero.optimizer.note, /nothing to optimize|no improvement/i);
  // Preferred slots honoured when possible
  const pref = cfg({ rules: { preferredSlots: { enabled: true, weight: 3, prefs: [{ kind: 'batch', name: 'S3 IT-A', slots: [1, 2, 3, 4] }] }, facultyGaps: { enabled: false } } });
  const p = S.generateTimetable(rows, pref);
  assert.equal(p.status, 'solved');
  assert.equal(p.softAfter.perRule.find((x) => x.id === 'S4_PREFERRED_SLOTS').violations, p.assignment.filter((a) => a.batch === 'S3 IT-A' && ![1, 2, 3, 4].includes(a.slot)).length);
});

test('12. CSV parsing: quoted commas, apostrophes, escaped quotes, duplicates', () => {
  const csv = [
    'Batch,Subject,Faculty_Name,Is_Lab,Weekly_Hours',
    'A,"Calc, I",Prof O\'Brien,false,3',
    'A,"Say ""Hi""",Dr. D\'Souza,false,2',
    'A,"Calc, I",Someone,false,3',
    'B,Maths,\'Quoted\',false,1',
  ].join('\n');
  const { rows, errors } = S.parseCSV(csv, { maxHours: 30 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].subject, 'Calc, I');
  assert.equal(rows[0].faculty, "Prof O'Brien");
  assert.equal(rows[1].subject, 'Say "Hi"');
  assert.equal(rows[2].faculty, "'Quoted'");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate of row 2/);
  assert.equal(S.csvQuote('a "b" c'), '"a ""b"" c"');
  assert.deepEqual([...S.parseCSVLine('x,"a,b",y\'z')], ['x', 'a,b', "y'z"]);
});

test('hard-rule auditor detects deliberately corrupted timetables', () => {
  const { rows } = S.parseCSV(SAMPLE_CSV, { maxHours: 30 });
  const c = cfg();
  const res = S.generateTimetable(rows, c);
  const ctx = S.buildContext(c, rows);
  const rules = S.buildRules(ctx);
  const bad = res.assignment.map((a) => ({ ...a }));
  bad[1] = { ...bad[0], subject: bad[1].subject, isLab: bad[1].isLab, batch: bad[1].batch, batchKey: bad[1].batchKey }; // same faculty+time+room as bad[0]
  const a = S.auditSolution(ctx, rules, bad);
  assert.equal(a.isValid, false);
  assert.ok(a.facultyCollisions > 0 && a.roomCollisions > 0);
  const missing = S.auditSolution(ctx, rules, res.assignment.slice(1));
  assert.equal(missing.hoursMismatches, 1);
  const labBad = res.assignment.map((a2) => (a2.isLab ? { ...a2, room: 'TR-101' } : a2));
  assert.ok(S.auditSolution(ctx, rules, labBad).roomTypeMismatches > 0);
});

test('DFS and FIFO BFS independently produce complete valid schedules with shared scoring', () => {
  const small = cfg({ workingDays: ['Mon'], slotsPerDay: 2, theoryRooms: ['R1'], labRooms: [] });
  const work = [row('A', 'Math', 'F1', false, 1), row('B', 'Science', 'F2', false, 1)];
  const dfs = S.generateBaselineTimetable(work, small, 'DFS', { maxNodes: 500, maxTimeMs: 1000 });
  const bfs = S.generateBaselineTimetable(work, small, 'BFS', { maxNodes: 500, maxTimeMs: 1000, maxQueue: 100 });
  for (const result of [dfs, bfs]) {
    assert.equal(result.status, 'solved');
    assert.equal(result.complete, true);
    assert.equal(result.valid, true);
    assert.equal(result.hardViolations, 0);
    assert.equal(result.softPenalty, S.softReport(S.buildContext(small, work), S.buildRules(S.buildContext(small, work)), result.assignment).cost);
    assert.ok(result.nodes > 0);
    assert.ok(result.generatedStates > 0);
  }
  assert.equal(dfs.backtracks == null, false);
  assert.equal(bfs.backtracks, null);
});

test('BFS reports a resource limit as inconclusive', () => {
  const small = cfg({ workingDays: ['Mon'], slotsPerDay: 4, theoryRooms: ['R1'], labRooms: [] });
  const work = [row('A', 'Math', 'F1', false, 2), row('B', 'Science', 'F2', false, 2)];
  const result = S.generateBaselineTimetable(work, small, 'BFS', { maxNodes: 1, maxTimeMs: 1000, maxQueue: 100 });
  assert.equal(result.status, 'aborted_node_limit');
  assert.notEqual(result.status, 'proven_unsolvable');
});

test('unavailability is honoured and diagnosed', () => {
  const { entries, errors } = S.parseUnavailabilityText('faculty:Prof X=Mon:*;Tue:1,2', ['Mon', 'Tue'], 3);
  assert.equal(errors.length, 0);
  const c = cfg({ workingDays: ['Mon', 'Tue'], slotsPerDay: 3, theoryRooms: ['R1', 'R2'], unavailable: entries });
  const ok = S.generateTimetable([row('A', 's', 'prof x', false, 1)], c);
  assert.equal(ok.status, 'solved');
  assert.equal(ok.assignment[0].day, 'Tue'); assert.equal(ok.assignment[0].slot, 2);
  const over = S.generateTimetable([row('A', 's', 'Prof X', false, 2)], c);
  assert.equal(over.status, 'proven_unsolvable');
  assert.match(over.reason, /only 1 available slot/);
  const never = S.parseUnavailabilityText('batch:A=Mon:*;Tue:*', ['Mon', 'Tue'], 3).entries;
  const n = S.generateTimetable([row('A', 's', 'T', false, 1)], { ...c, unavailable: never });
  assert.match(n.reason, /unavailable in every slot/);
});
