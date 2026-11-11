/**
 * dsh-research-solver 的确定性引擎。
 *
 * 这个文件是「可复算」的根基：同样的 state.json 一定得到同样的排名、
 * 同样的帕累托前沿、同样的结论。任何给人看的数字都必须能从 state 里算回来，
 * 不允许出现「模型临场发挥出来的评价」。
 *
 * 纯函数、无 I/O、不读时钟。
 */

export const STATE_VERSION = 1;

/** 四阶段。编号即流程顺序，不允许跳阶段。 */
export const STAGES = [
  { n: 1, key: 'collect', name: '资料收集', goal: '先把别人的做法和不足摊开' },
  { n: 2, key: 'evaluate', name: '指标与评估', goal: '用同一套尺子量所有方案' },
  { n: 3, key: 'fuse', name: '改进与融合', goal: '针对短板补，而不是重新发明' },
  { n: 4, key: 'iterate', name: '迭代改善', goal: '用同一套尺子再看一次，只认数' },
];

/** 检索阶梯（原则二：能本地就不联网）。tier 越小越省资源。 */
export const TIERS = [
  { n: 0, key: 'workspace', name: '本地工作区文件' },
  { n: 1, key: 'knowledge', name: '本地知识库 / 文献库' },
  { n: 2, key: 'local-app', name: '本机应用 / MCP' },
  { n: 3, key: 'web', name: '网络检索' },
];

export const ID_PREFIX = { source: 's', gap: 'g', candidate: 'c' };

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const pct = (x) => `${Math.round(x * 100)}%`;
const num = (n) => (Number.isFinite(n) ? String(r2(n)) : '—');

/** 新建一份空状态。时间由调用方注入，保持引擎无时钟。 */
export function emptyState({ slug, title, goal, now }) {
  return {
    version: STATE_VERSION,
    slug,
    title,
    goal,
    createdAt: now,
    updatedAt: now,
    counter: { source: 0, gap: 0, candidate: 0, round: 0 },
    metricsVersion: 0,
    sources: [],
    gaps: [],
    metrics: [],
    candidates: [],
    rounds: [],
    decisions: [],
    chosen: null,
  };
}

export function nextId(state, kind) {
  const prefix = ID_PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  state.counter[kind] = (state.counter[kind] ?? 0) + 1;
  return `${prefix}-${state.counter[kind]}`;
}

/** 阶段由内容推导，不由人声明——声明会撒谎，内容不会。 */
export function computeStage(state) {
  if (state.rounds.length >= 2) return 4;
  if (state.candidates.some((c) => c.kind === 'fused')) return 3;
  if (state.rounds.length >= 1) return 2;
  if (state.metrics.length > 0 && state.candidates.length > 0) return 2;
  return 1;
}

export function stageInfo(n) {
  return STAGES.find((s) => s.n === n) ?? STAGES[0];
}

/** 权重归一化：允许用户随手写 20/20/20/20/10/10，内部按和为 1 处理。 */
export function effectiveWeights(metrics) {
  const sum = metrics.reduce((a, m) => a + (Number.isFinite(m.weight) ? Math.max(0, m.weight) : 0), 0);
  const map = new Map();
  for (const m of metrics) {
    const w = sum > 0 ? Math.max(0, m.weight || 0) / sum : 1 / Math.max(1, metrics.length);
    map.set(m.id, w);
  }
  return { map, rawSum: r2(sum), equal: sum <= 0 };
}

/** 单指标归一化到 0..1；direction=lower 表示分数越低越好。 */
export function metricNorm(metric, raw) {
  const s = clamp(raw, 0, 10);
  const norm = metric.direction === 'lower' ? (10 - s) / 10 : s / 10;
  return { raw: s, norm };
}

/** 排名：只对指标齐全的候选计分；缺项的排后面并单列。 */
export function rankCandidates(state) {
  const { map, rawSum, equal } = effectiveWeights(state.metrics);
  const rows = state.candidates.map((c) => {
    const given = new Map((c.scores ?? []).map((s) => [s.metric, s.value]));
    const per = [];
    const missing = [];
    let total = 0;
    for (const m of state.metrics) {
      const raw = given.get(m.id);
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        missing.push(m.id);
        per.push({ metric: m.id, raw: null, norm: 0 });
        continue;
      }
      const { raw: v, norm } = metricNorm(m, raw);
      per.push({ metric: m.id, raw: r2(v), norm: r2(norm) });
      total += (map.get(m.id) ?? 0) * norm;
    }
    return {
      id: c.id,
      name: c.name,
      kind: c.kind ?? 'existing',
      round: c.round ?? 1,
      per,
      missing,
      complete: missing.length === 0,
      total: r2(total),
    };
  });

  const front = paretoFront(rows.filter((r) => r.complete));
  for (const r of rows) r.pareto = front.has(r.id);

  const sorted = [...rows].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return b.total - a.total;
  });
  sorted.forEach((r, i) => { r.rank = i + 1; });
  return { rows: sorted, weights: map, rawSum, equal };
}

/** 帕累托前沿：没有任何其他候选在每个指标上都不差且至少一项更好。 */
export function paretoFront(rows) {
  const front = new Set();
  for (const a of rows) {
    const dominated = rows.some((b) => {
      if (b.id === a.id) return false;
      let better = false;
      for (const pa of a.per) {
        const pb = b.per.find((x) => x.metric === pa.metric);
        if (!pb) return false;
        if (pb.norm < pa.norm) return false;
        if (pb.norm > pa.norm) better = true;
      }
      return better;
    });
    if (!dominated) front.add(a.id);
  }
  return front;
}

/** 不足覆盖率：被「及格（≥0.6）方案」认领的不足 / 全部不足。 */
export function gapCoverage(state, rows) {
  const total = state.gaps.length;
  if (total === 0) return { total: 0, covered: 0, ratio: 0, uncovered: [] };
  const covered = new Set();
  const byId = new Map(state.candidates.map((c) => [c.id, c]));
  for (const r of rows) {
    if (!r.complete || r.total < 0.6) continue;
    for (const g of byId.get(r.id)?.gapIds ?? []) covered.add(g);
  }
  const uncovered = state.gaps.filter((g) => !covered.has(g.id)).map((g) => g.id);
  return { total, covered: covered.size, ratio: r2(covered.size / total), uncovered };
}

/** 本地占比：tier ≤ 2 的资料条目比例，直接对应原则二。 */
export function localRatio(sources) {
  if (sources.length === 0) return { total: 0, local: 0, ratio: 0 };
  const local = sources.filter((s) => (s.tier ?? 3) <= 2).length;
  return { total: sources.length, local, ratio: r2(local / sources.length) };
}

/** 确定性体检。检查不通过不阻止渲染，但必须原样呈现给人。 */
export function findings(state, analysis) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });

  if (state.metrics.length === 0) add('error', 'M001', '还没有登记评价指标，任何评分都无法解释。');
  if (!analysis.weights.equal && Math.abs(analysis.weights.rawSum - 1) > 0.01) {
    add('info', 'M002', `指标权重之和为 ${analysis.weights.rawSum}，已按比例归一化，不改变排序。`);
  }

  const dupMetric = dupes(state.metrics.map((m) => m.id));
  if (dupMetric.length) add('error', 'M003', `指标 id 重复：${dupMetric.join(', ')}。`);

  for (const r of analysis.rows) {
    if (!r.complete) add('warn', 'C001', `候选 ${r.id} 缺指标评分：${r.missing.join(', ')}，不参与排名。`);
  }

  const cand = new Map(state.candidates.map((c) => [c.id, c]));
  for (const c of state.candidates) {
    if (!(c.gapIds ?? []).length) add('warn', 'C002', `候选 ${c.id} 没有认领任何不足，创新点无法回溯。`);
    for (const g of c.gapIds ?? []) {
      if (!state.gaps.some((x) => x.id === g)) add('error', 'C003', `候选 ${c.id} 引用了不存在的不足 ${g}。`);
    }
    for (const s of c.scores ?? []) {
      if (!state.metrics.some((m) => m.id === s.metric)) add('error', 'C004', `候选 ${c.id} 使用了未登记指标 ${s.metric}。`);
      if (typeof s.value !== 'number' || s.value < 0 || s.value > 10) add('error', 'C005', `候选 ${c.id} 的 ${s.metric} 分值超出 0..10。`);
    }
    if ((c.kind ?? 'existing') === 'fused' && !(c.fuses ?? []).length) {
      add('warn', 'C006', `融合方案 ${c.id} 没有登记它融合了谁。`);
    }
  }

  for (const g of state.gaps) {
    if (!(g.evidence ?? []).length) add('warn', 'G001', `不足 ${g.id} 没有引用任何资料，属于印象判断。`);
    for (const e of g.evidence ?? []) {
      if (!state.sources.some((s) => s.id === e)) add('error', 'G002', `不足 ${g.id} 引用了不存在的资料 ${e}。`);
    }
  }

  for (const s of state.sources) {
    if ((s.tier ?? 3) >= 3 && !String(s.whyLocalFailed ?? '').trim()) {
      add('error', 'S001', `资料 ${s.id} 走了网络，但没有记录「本地为什么不够」。`);
    }
  }

  if (analysis.local.ratio < 0.5 && analysis.local.total >= 3) {
    add('warn', 'S002', `本地资料占比 ${pct(analysis.local.ratio)}，低于 50%，检索阶梯可能被跳过。`);
  }

  if (state.candidates.length > 0 && !state.candidates.some((c) => (c.kind ?? 'existing') === 'fused')) {
    add('info', 'F001', '还没有融合/改进类方案：阶段三未开始，当前只是横向比较。');
  }

  const lastRound = state.rounds[state.rounds.length - 1];
  if (lastRound && lastRound.metricsVersion !== state.metricsVersion) {
    add('error', 'R001', '指标在评估之后被改过，最后一轮结论已过期，需要重新 evaluate。');
  }

  if (state.chosen && cand.has(state.chosen)) {
    const row = analysis.rows.find((r) => r.id === state.chosen);
    if (row && !row.pareto) add('warn', 'R002', `选中的 ${state.chosen} 不在帕累托前沿上：存在全面不差的方案。`);
  }
  return out;
}

function dupes(list) {
  const seen = new Set();
  const d = new Set();
  for (const x of list) { if (seen.has(x)) d.add(x); seen.add(x); }
  return [...d];
}

/** 阶段产物齐全度：缺什么就明说，别让下一轮猜。 */
export function stageGaps(state, analysis) {
  const missing = [];
  if (state.sources.length === 0) missing.push('还没有任何资料 → action=source');
  if (state.gaps.length === 0) missing.push('还没有登记别人做不好什么 → action=gap');
  if (state.metrics.length === 0) missing.push('还没有评价指标 → action=metric');
  if (state.candidates.length === 0) missing.push('还没有候选方案 → action=candidate');
  if (state.candidates.length === 1) missing.push('只有一个候选，没有比较就没有取舍 → 再补一个');
  if (state.candidates.length >= 2 && state.rounds.length === 0) missing.push('还没有正式评估 → research_score action=evaluate');
  const all = findings(state, analysis);
  for (const f of all) if (f.level === 'error') missing.push(`[${f.code}] ${f.message}`);
  return missing;
}

/** 聚合分析结果，供工具与渲染共用。 */
export function analyze(state) {
  const { rows, weights, rawSum, equal } = rankCandidates(state);
  const front = new Set(rows.filter((r) => r.pareto).map((r) => r.id));
  const gap = gapCoverage(state, rows);
  const local = localRatio(state.sources);
  const stage = computeStage(state);
  const base = {
    stage,
    stageInfo: stageInfo(stage),
    rows,
    weights,
    weightsRawSum: rawSum,
    weightsEqual: equal,
    pareto: front,
    gap,
    local,
    top: rows.find((r) => r.complete) ?? null,
  };
  base.findings = findings(state, base);
  base.missing = stageGaps(state, base);
  return base;
}

/** 把当前排名压成一轮快照。 */
export function snapshot(state, analysis, { hypothesis, changes, now }) {
  state.counter.round = (state.counter.round ?? 0) + 1;
  const round = {
    n: state.counter.round,
    at: now,
    hypothesis: hypothesis ?? '',
    changes: changes ?? [],
    metricsVersion: state.metricsVersion,
    ranking: analysis.rows.map((r) => ({ id: r.id, name: r.name, total: r.total, rank: r.rank, complete: r.complete })),
    pareto: [...analysis.pareto],
    localRatio: analysis.local.ratio,
    gapCoverage: analysis.gap.ratio,
    top: analysis.top?.id ?? null,
  };
  state.rounds.push(round);
  return round;
}

/** 轮次差分：同一候选的分数变化，以及逐指标的变化。 */
export function delta(state) {
  const n = state.rounds.length;
  if (n < 2) return null;
  const prev = state.rounds[n - 2];
  const curr = state.rounds[n - 1];
  const prevById = new Map(prev.ranking.map((r) => [r.id, r]));
  const rows = curr.ranking.map((r) => ({
    id: r.id,
    name: r.name,
    before: prevById.get(r.id)?.total ?? null,
    after: r.total,
    diff: prevById.has(r.id) ? r2(r.total - prevById.get(r.id).total) : null,
    rankBefore: prevById.get(r.id)?.rank ?? null,
    rankAfter: r.rank,
  }));
  const regressions = rows.filter((r) => r.diff !== null && r.diff < -0.001).map((r) => r.id);
  return {
    from: prev.n,
    to: curr.n,
    rows,
    regressions,
    localBefore: prev.localRatio,
    localAfter: curr.localRatio,
    gapBefore: prev.gapCoverage,
    gapAfter: curr.gapCoverage,
  };
}

/** 候选在某一轮的逐指标明细（用于 03/04 的对照表）。 */
export function candidateDetail(state, id) {
  const c = state.candidates.find((x) => x.id === id);
  if (!c) return null;
  const scores = new Map((c.scores ?? []).map((s) => [s.metric, s.value]));
  const { map } = effectiveWeights(state.metrics);
  return {
    ...c,
    detail: state.metrics.map((m) => {
      const raw = scores.get(m.id);
      return {
        metric: m.id,
        name: m.name,
        raw: typeof raw === 'number' ? r2(raw) : null,
        norm: typeof raw === 'number' ? r2(metricNorm(m, raw).norm) : null,
        weight: r2(map.get(m.id) ?? 0),
      };
    }),
  };
}

export { r2, num, clamp };
