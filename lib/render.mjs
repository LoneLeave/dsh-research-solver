/**
 * 把 state + analysis 渲染成人能读的产物。
 *
 * 纯函数：同样的 state 渲染出逐字节相同的文件（时间只取 state 里的字段）。
 * 这正是 `check` 能靠 sha256 判断「文件有没有被手改过」的前提。
 */

import { STAGES, TIERS, pct, r2 } from './engine.mjs';

export const HUMAN_PATHS = {
  readme: 'human/交流/README.md',
  decisions: 'human/交流/决策记录.md',
  overview: 'human/流程展示/00-总览.md',
  collect: 'human/流程展示/01-资料收集.md',
  evaluate: 'human/流程展示/02-方案评估.md',
  fuse: 'human/流程展示/03-改进与融合.md',
  iterate: 'human/流程展示/04-迭代分析.md',
  deliverable: 'human/成品/方案.md',
  csv: 'human/可验证中间过程/评分表.csv',
  checklist: 'human/可验证中间过程/校验清单.md',
};

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const cell = (s) => (s === null || s === undefined || s === '' ? '—' : esc(s));
const list = (a) => (Array.isArray(a) && a.length ? a : []);

function table(headers, rows) {
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function stageBanner(state, a) {
  const done = STAGES.filter((s) => s.n < a.stage).length;
  const bar = STAGES.map((s) => (s.n <= a.stage ? '●' : '○')).join(' ');
  return `**阶段 ${a.stage}/4 · ${a.stageInfo.name}**　${bar}　已完成 ${done} 步 ｜ 更新 ${state.updatedAt}`;
}

function missingBlock(a) {
  if (!a.missing.length) return '> 自检无阻塞项，可以进入下一步。';
  return ['> 自检发现以下缺口：', ...a.missing.map((m) => `> - ${m}`)].join('\n');
}

function scoreCell(row, metricId) {
  const p = row.per.find((x) => x.metric === metricId);
  if (!p) return '—';
  if (p.raw === null) return '缺';
  return `${p.raw}`;
}

/* ------------------------------------------------------------------ 00 总览 */

function overview(state, a) {
  const top = a.top;
  const verdict = top
    ? `**${top.name}**（${top.id}）以 ${top.total.toFixed(2)} / 1.00 分暂列第一；不足覆盖率 ${pct(a.gap.ratio)}（${a.gap.covered}/${a.gap.total}）${
        a.gap.uncovered.length ? `，还有 ${a.gap.uncovered.length} 条没人认领` : ''
      }。`
    : '还没有可排名的候选方案。';

  const stageRows = STAGES.map((s) => [
    `${s.n}`,
    s.name,
    s.n < a.stage ? '已完成' : s.n === a.stage ? '**进行中**' : '未开始',
    s.goal,
  ]);

  const brief = [
    table(['#', '阶段', '状态', '这一步要产出什么'], stageRows),
    '',
    '## 关键数字',
    '',
    table(
      ['指标', '值', '含义'],
      [
        ['资料条目', `${a.local.total}`, `其中本地 ${a.local.local} 条（tier ≤ 2）`],
        ['本地占比', pct(a.local.ratio), '原则二的直接度量：能本地就不联网'],
        ['不足条目', `${a.gap.total}`, '从资料里抠出来的「别人做不好什么」'],
        ['不足覆盖', pct(a.gap.ratio), '被及格方案（≥0.60）认领的比例'],
        ['候选方案', `${state.candidates.length}`, '横向可比的方案数量'],
        ['评估轮次', `${state.rounds.length}`, '每轮冻结一次排名快照'],
      ],
    ),
    '',
    '## 排名',
    '',
    a.rows.length
      ? table(
          ['#', '方案', '类型', '总分', '帕累托', '缺项'],
          a.rows.map((r) => [
            `${r.rank}`,
            `${r.name}（${r.id}）`,
            r.kind === 'fused' ? '融合/改进' : '已有方案',
            r.complete ? r.total.toFixed(2) : '不可比',
            r.pareto ? '是' : '—',
            r.missing.length ? r.missing.join(', ') : '—',
          ]),
        )
      : '（无）',
    '',
    '## 下一步',
    '',
    missingBlock(a),
  ].join('\n');

  return [
    `# ${state.title}`,
    '',
    `> 目标：${state.goal || '（未填写）'}`,
    '',
    stageBanner(state, a),
    '',
    '## 一句话结论',
    '',
    verdict,
    '',
    brief,
    '',
  ].join('\n');
}

/* -------------------------------------------------------------- 01 资料收集 */

function collect(state, a) {
  const tierRows = TIERS.map((t) => [
    `${t.n}`,
    t.name,
    `${state.sources.filter((s) => (s.tier ?? 3) === t.n).length}`,
    t.n <= 2 ? '优先' : '需说明理由',
  ]);

  const srcRows = state.sources.map((s) => [
    s.id,
    `${s.tier ?? 3}`,
    s.kind || '—',
    s.title,
    s.locator || '—',
    (s.tier ?? 3) >= 3 ? s.whyLocalFailed || '**未说明**' : '—',
  ]);

  const gapRows = state.gaps.map((g) => [
    g.id,
    g.target || '—',
    g.gap,
    g.impact || '—',
    list(g.evidence).join(' ') || '**无证据**',
  ]);

  return [
    `# 01 资料收集`,
    '',
    stageBanner(state, a),
    '',
    '## 检索阶梯（原则二：先近后远）',
    '',
    table(['tier', '来源类型', '条数', '策略'], tierRows),
    '',
    `**本地占比 ${pct(a.local.ratio)}**（${a.local.local}/${a.local.total}）。低于 50% 意味着检索阶梯被跳过，` +
      'reviewer 有权质疑「你其实没先看本地」。',
    '',
    '## 资料清单',
    '',
    srcRows.length ? table(['id', 'tier', '类型', '标题', '定位', '联网理由'], srcRows) : '（暂无资料）',
    '',
    '## 不足清单（原则一：创新点必须落在别人的不足上）',
    '',
    gapRows.length
      ? table(['id', '谁做不好', '具体不足', '影响', '证据'], gapRows)
      : '（暂无。没有不足清单就没有创新点，只有功能罗列。）',
    '',
    ...(state.gaps.length
      ? [
          '',
          '> 每条不足都必须能指回上面的资料 id。指不回去的，是你自己的印象，不是别人的不足。',
        ]
      : []),
    '',
  ].join('\n');
}

/* -------------------------------------------------------------- 02 方案评估 */

function evaluate(state, a) {
  const metricRows = state.metrics.map((m) => [
    m.id,
    m.name,
    m.direction === 'lower' ? '越低越好' : '越高越好',
    r2((a.weights.get(m.id) ?? 0) * 100) + '%',
    m.definition || '—',
  ]);

  const headers = ['方案', ...state.metrics.map((m) => m.id), '总分', '#', '前沿'];
  const matrix = a.rows.map((r) => [
    `${r.name}（${r.id}）`,
    ...state.metrics.map((m) => scoreCell(r, m.id)),
    r.complete ? r.total.toFixed(2) : '不可比',
    `${r.rank}`,
    r.pareto ? '●' : '',
  ]);

  const proRows = [];
  for (const c of state.candidates) {
    proRows.push([
      `${c.name}（${c.id}）`,
      list(c.strengths).join('；') || '—',
      list(c.weaknesses).join('；') || '—',
      list(c.gapIds).join(' ') || '**未认领**',
    ]);
  }

  return [
    '# 02 方案评估',
    '',
    stageBanner(state, a),
    '',
    '## 评价指标（先定尺子，再量东西）',
    '',
    metricRows.length
      ? table(['id', '指标', '方向', '权重', '判定依据'], metricRows)
      : '（暂无指标。没有尺子的评分只是态度。）',
    '',
    `权重之和 ${a.weightsRawSum}，内部按比例归一化；归一化不改变排序，只改变分量级。`,
    '',
    '## 评分矩阵（0–10 原始分）',
    '',
    matrix.length ? table(headers, matrix) : '（暂无候选）',
    '',
    '## 优缺点与创新点归属',
    '',
    proRows.length ? table(['方案', '优点', '缺点', '认领的不足'], proRows) : '（暂无候选）',
    '',
    '## 帕累托前沿',
    '',
    a.pareto.size
      ? `前沿上的方案：${[...a.pareto].join('、')}。\n\n前沿之外的方案，在**每一个**指标上都不优于某个前沿方案——它们没有存在的理由，除非成本更低。`
      : '（无可比方案，无法判定前沿）',
    '',
    '## 加权贡献（谁把分拉上去的）',
    '',
    ...a.rows
      .filter((r) => r.complete)
      .map((r) => {
        const parts = r.per
          .map((p) => ({ id: p.metric, contrib: (a.weights.get(p.metric) ?? 0) * p.norm }))
          .sort((x, y) => y.contrib - x.contrib);
        return `- **${r.id}** ＝ ${parts.map((p) => `${p.id} ${r2(p.contrib).toFixed(2)}`).join(' ＋ ')} ＝ ${r.total.toFixed(2)}`;
      }),
    '',
  ].join('\n');
}

/* ---------------------------------------------------------- 03 改进与融合 */

function fuse(state, a) {
  const fused = state.candidates.filter((c) => (c.kind ?? 'existing') === 'fused');
  const rows = fused.map((c) => {
    const parents = (c.fuses ?? []).map((id) => state.candidates.find((x) => x.id === id)).filter(Boolean);
    const diffs = [];
    for (const p of parents) {
      const mine = new Map((c.scores ?? []).map((s) => [s.metric, s.value]));
      const theirs = new Map((p.scores ?? []).map((s) => [s.metric, s.value]));
      const better = [];
      for (const [k, v] of mine) {
        const t = theirs.get(k);
        if (typeof t === 'number' && typeof v === 'number') {
          const m = state.metrics.find((x) => x.id === k);
          const lower = m?.direction === 'lower';
          const gain = lower ? t - v : v - t;
          if (gain > 0) better.push(`${k}+${r2(gain)}`);
          if (gain < 0) better.push(`${k}${r2(gain)}`);
        }
      }
      diffs.push(`vs ${p.id}：${better.length ? better.join(', ') : '无净变化'}`);
    }
    return [
      `${c.name}（${c.id}）`,
      list(c.fuses).join(' ') || '**未登记**',
      list(c.fixes).join('；') || '—',
      diffs.join('<br>') || '—',
    ];
  });

  return [
    '# 03 改进与融合',
    '',
    stageBanner(state, a),
    '',
    '## 做法：不重新发明，只补短板',
    '',
    '阶段二的矩阵已经指出每条方案弱在哪个指标。阶段三只做三件事：',
    '',
    '1. **补**：某方案在某个低权重但致命的指标上很差 → 直接换掉该模块；',
    '2. **融**：A 强在甲指标、B 强在乙指标，且二者不互斥 → 合成一个方案；',
    '3. **删**：某个被前沿支配的方案，如果没有成本优势，就不该留在讨论里。',
    '',
    '## 融合方案',
    '',
    rows.length ? table(['融合方案', '融合来源', '补了什么', '相对父方案的变化'], rows) : '（尚未产生融合方案）',
    '',
    rows.length
      ? '> 「相对父方案的变化」按指标方向折算为增益，正数为变好。负数必须解释：融合常常换来一个新短板。'
      : '> 先做完阶段二，再决定要不要融。没有矩阵就融合，等于把两个未知混成一个未知。',
    '',
    '## 不足覆盖更新',
    '',
    table(
      ['项', '值'],
      [
        ['已认领不足', `${a.gap.covered}/${a.gap.total}`],
        ['覆盖率', pct(a.gap.ratio)],
        ['仍无人认领', a.gap.uncovered.join(' ') || '无'],
      ],
    ),
    '',
    a.gap.uncovered.length
      ? `未覆盖的 ${a.gap.uncovered.length} 条不足，要么补一个新方案，要么明确写「本次不解决，理由：…」。沉默不算解决。`
      : '所有不足都有方案认领。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------ 04 迭代分析 */

function iterate(state, a) {
  const rounds = state.rounds;
  const roundRows = rounds.map((r) => [
    `R${r.n}`,
    r.at,
    r.hypothesis || '—',
    list(r.changes).join('；') || '—',
    r.top || '—',
    pct(r.localRatio),
    pct(r.gapCoverage),
  ]);

  let deltaSection = '（只有一轮，还没有可比对象。改动后再 evaluate 一次。）';
  if (rounds.length >= 2) {
    const prev = rounds[rounds.length - 2];
    const curr = rounds[rounds.length - 1];
    const byId = new Map(prev.ranking.map((r) => [r.id, r]));
    const rows = curr.ranking.map((r) => {
      const b = byId.get(r.id);
      const diff = b ? r2(r.total - b.total) : null;
      return [
        `${r.name}（${r.id}）`,
        b ? b.total.toFixed(2) : '—',
        r.complete ? r.total.toFixed(2) : '不可比',
        diff === null ? '新增' : (diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)),
        b ? `${b.rank} → ${r.rank}` : '新增',
        diff !== null && diff < -0.001 ? '**回归**' : '',
      ];
    });
    const regressed = rows.filter((r) => r[5]);
    deltaSection = [
      table(['方案', `R${prev.n}`, `R${curr.n}`, 'Δ', '名次', '风险'], rows),
      '',
      table(
        ['宏观指标', `R${prev.n}`, `R${curr.n}`, 'Δ'],
        [
          ['本地占比', pct(prev.localRatio), pct(curr.localRatio), r2(curr.localRatio - prev.localRatio).toFixed(2)],
          ['不足覆盖', pct(prev.gapCoverage), pct(curr.gapCoverage), r2(curr.gapCoverage - prev.gapCoverage).toFixed(2)],
        ],
      ),
      '',
      regressed.length
        ? `**回归项**：${regressed.map((r) => r[0]).join('、')}。总分会掩盖单项退步，必须回到 02 的矩阵看是哪一格掉了。`
        : '本轮无单项回归。',
    ].join('\n');
  }

  return [
    '# 04 迭代分析',
    '',
    stageBanner(state, a),
    '',
    '## 轮次记录',
    '',
    rounds.length ? table(['轮', '时间', '本轮假设', '改了什么', '领先方案', '本地占比', '覆盖'], roundRows) : '（尚未评估）',
    '',
    '## 与上一轮对比',
    '',
    deltaSection,
    '',
    '## 迭代纪律',
    '',
    table(
      ['规则', '为什么'],
      [
        ['每轮只改一类东西', '同时改指标和方案，分不清是尺子变了还是东西变好了'],
        ['改指标必须重跑全部评分', '指标一改，旧结论立即过期（否则 check 报 R001）'],
        ['只看同一套尺子下的差分', '跨尺子的分数不可比，比了等于自欺'],
        ['回归项必须逐格解释', '总分上涨掩盖单项下跌，是最常见的自我欺骗'],
      ],
    ),
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------- 成品方案 */

function deliverable(state, a) {
  const target = state.chosen
    ? state.candidates.find((c) => c.id === state.chosen)
    : a.top
      ? state.candidates.find((c) => c.id === a.top.id)
      : null;
  if (!target) {
    return [
      `# ${state.title} · 方案`,
      '',
      '> 还没有可交付的方案。至少需要一个指标齐全、完成评估的候选。',
      '',
    ].join('\n');
  }

  const row = a.rows.find((r) => r.id === target.id);
  const gapMap = new Map(state.gaps.map((g) => [g.id, g]));
  const claimed = list(target.gapIds).map((id) => gapMap.get(id)).filter(Boolean);
  const scores = new Map((target.scores ?? []).map((s) => [s.metric, s]));

  return [
    `# ${target.name}`,
    '',
    `> 项目：${state.title}　｜　方案 id：${target.id}　｜　类型：${target.kind === 'fused' ? '融合/改进' : '已有方案改进'}　｜　总分 ${row ? row.total.toFixed(2) : '不可比'}${row?.pareto ? '（帕累托前沿）' : ''}`,
    '',
    '## 要解决的问题',
    '',
    state.goal || '（未填写目标）',
    '',
    '## 它补的是谁的不足（创新点来源）',
    '',
    claimed.length
      ? table(
          ['不足 id', '谁做不好', '不足', '不补会怎样'],
          claimed.map((g) => [g.id, g.target || '—', g.gap, g.impact || '—']),
        )
      : '（本方案没有认领具体不足——按原则一，这还不能算创新点。）',
    '',
    ...(list(target.fixes).length
      ? ['**针对这些不足，本方案做的改动**', '', ...list(target.fixes).map((f) => `- ${f}`), '']
      : []),
    '## 方案本体',
    '',
    target.summary || '（待补充方案说明）',
    ...(list(target.fuses).length
      ? ['', `**融合来源**：${list(target.fuses).join('、')}（相对父方案的逐项变化见 03 改进与融合）`]
      : []),
    '',
    '## 指标表现',
    '',
    table(
      ['指标', '原始分', '归一化', '权重', '加权贡献'],
      state.metrics.map((m) => {
        const s = scores.get(m.id);
        const w = a.weights.get(m.id) ?? 0;
        const raw = typeof s?.value === 'number' ? s.value : null;
        const entry = row?.per.find((p) => p.metric === m.id);
        return [
          `${m.name}（${m.id}）`,
          raw === null ? '缺' : r2(raw),
          entry ? r2(entry.norm) : '—',
          `${r2(w * 100)}%`,
          entry ? r2(w * entry.norm) : '—',
        ];
      }),
    ),
    '',
    '## 已知短板与残余风险',
    '',
    list(target.weaknesses).length ? list(target.weaknesses).map((w) => `- ${w}`).join('\n') : '- （未填写）',
    '',
    ...(a.gap.uncovered.length
      ? [`- 本方案未覆盖的不足：${a.gap.uncovered.join('、')}，属于已知遗留，不是遗漏。`]
      : []),
    '',
    '## 怎么验证',
    '',
    '```bash',
    `# 1. 复算排名（应与本文件一致）`,
    `research_score action=compare project=${state.slug}`,
    `# 2. 自检（无 error 才算可交付）`,
    `research_task action=check project=${state.slug}`,
    '```',
    '',
    '## 证据链',
    '',
    table(
      ['环节', '入口'],
      [
        ['资料与不足', 'human/流程展示/01-资料收集.md'],
        ['指标与评分', 'human/流程展示/02-方案评估.md'],
        ['融合过程', 'human/流程展示/03-改进与融合.md'],
        ['迭代差分', 'human/流程展示/04-迭代分析.md'],
        ['可复算原始分数', 'human/可验证中间过程/评分表.csv'],
        ['机器可读状态', 'ai/state.json'],
      ],
    ),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ 评分表 */

function scoreCsv(state, a) {
  const rows = [['candidate_id', 'candidate_name', 'metric_id', 'metric_name', 'raw', 'norm', 'weight', 'weighted']];
  for (const r of a.rows) {
    for (const m of state.metrics) {
      const p = r.per.find((x) => x.metric === m.id);
      const w = a.weights.get(m.id) ?? 0;
      rows.push([
        r.id,
        r.name,
        m.id,
        m.name,
        p && p.raw !== null ? p.raw : '',
        p && p.raw !== null ? p.norm : '',
        r2(w),
        p && p.raw !== null ? r2(w * p.norm) : '',
      ]);
    }
    rows.push([r.id, r.name, '__total__', '加权总分', '', '', '', r.complete ? r.total : '']);
  }
  return csv(rows);
}

/* ---------------------------------------------------------------- 校验清单 */

function checklist(state, a) {
  const levelLabel = { error: '阻塞', warn: '需说明', info: '提示' };
  const hint = {
    M001: '先 research_task action=metric 登记至少 3 个指标，写清方向与权重。',
    M002: '无需处理：归一化只改变分量级，不改变排序。',
    M003: '指标 id 重复会让权重叠加，改掉重复的那条。',
    C001: '缺指标评分的方案不参与排名；补分，或删掉该方案。',
    C002: '在 candidate 的 gapIds 里写明它补的是哪条不足。',
    C003: '引用了不存在的不足 id，先补 gap 或改 id。',
    C004: '评分用了未登记指标，先登记指标再评分。',
    C005: '分值必须在 0..10。',
    C006: '融合方案必须写 fuses，否则无法回溯它是哪来的。',
    G001: '给不足补 evidence（资料 id）。',
    G002: '不足引用了不存在的资料 id。',
    S001: '联网资料必须写 whyLocalFailed，否则违反原则二。',
    S002: '补本地资料，或说明本地确实没有。',
    F001: '进入阶段三：基于矩阵短板做融合方案。',
    R001: '指标改过，最后一轮结论过期：重跑 research_score action=evaluate。',
    R002: '所选方案被支配，换方案或解释为什么仍选它。',
  };

  const rows = a.findings.map((f) => [f.code, levelLabel[f.level] ?? f.level, f.message, hint[f.code] ?? '']);

  return [
    '# 校验清单（可验证中间过程）',
    '',
    stageBanner(state, a),
    '',
    '这份清单由确定性代码生成，不由模型总结。每条都能用文件里的数字复算。',
    '',
    a.findings.length ? table(['码', '级别', '问题', '怎么改'], rows) : '自检未发现问题。',
    '',
    '## 人工复核顺序',
    '',
    '1. 打开 `human/可验证中间过程/评分表.csv`，随便挑一行：`weighted = norm × weight`，`总分 = Σ weighted`；',
    '2. 用 `research_score action=compare` 复算，总分应逐位相同（引擎是纯函数）；',
    '3. 抽查一条不足，顺着它的 `evidence` 指到 `ai/evidence/sources.jsonl`，确认那条资料真的说了这件事；',
    '4. 抽查一条网络资料，确认 `whyLocalFailed` 不是套话。',
    '',
    '## 文件指纹',
    '',
    `所有 human/ 文件的内容哈希记录在 \`ai/index.json\`。任何手改都会让 \`research_task action=check\` 报「文件被改动」。`,
    '',
  ].join('\n');
}

/* -------------------------------------------------------------- 交流/README */

function readme(state) {
  return [
    `# ${state.title} · 阅读入口`,
    '',
    `> 目标：${state.goal || '（未填写）'}`,
    '',
    '这个目录里的文件是**给人看的**。机器用的状态在上一级的 `ai/` 里，不要手改。',
    '',
    '## 三类文件',
    '',
    table(
      ['目录', '给谁', '放什么', '怎么读'],
      [
        ['`交流/`', '对话双方', '入口说明、决策记录', '先看这页，再看决策为什么这么定'],
        ['`流程展示/`', '评审者', '四个阶段的完整推演（00–04）', '按编号顺序读，每一步都有数字'],
        ['`成品/`', '使用者', '最终方案：问题、创新点、指标、风险、验证方式', '只想要结果就读这一份'],
        ['`可验证中间过程/`', '怀疑者', '评分表 CSV、校验清单', '用来复算和打假'],
      ],
    ),
    '',
    '## 为什么这样分',
    '',
    '- **交流**是给人快速建立共识的，不承载证据；',
    '- **流程展示**承载「你怎么想的」，缺了它，成品就是一个无法反驳的断言；',
    '- **成品**只回答「所以做什么」，不重复论证；',
    '- **可验证中间过程**承载「凭什么信你」，所有数字都在这里可复算。',
    '',
    '证据从下往上支撑，结论从上往下阅读。任何一层缺失，都会被 `research_task action=check` 指出来。',
    '',
    '## AI 用的那一半',
    '',
    table(
      ['文件', '作用'],
      [
        ['`ai/state.json`', '唯一真相源。所有 human/ 文件都由它渲染'],
        ['`ai/index.json`', 'human/ 文件的 sha256 指纹，用于检测手改'],
        ['`ai/evidence/sources.jsonl`', '资料逐行记录，便于 grep 与追加'],
        ['`ai/log.jsonl`', '每次工具调用的审计日志'],
      ],
    ),
    '',
    '> 手改 `human/` 下的文件不会影响结论，但会在下次 `check` 时被标记；手改 `ai/state.json` 会让所有下游产物与状态不一致。',
    '',
  ].join('\n');
}

/* --------------------------------------------------------------- 决策记录 */

function decisions(state) {
  const rows = state.decisions.map((d) => [`${d.at}`, d.action, d.note || '—']);
  return [
    '# 决策记录',
    '',
    '按时间追加，只记「为什么」，不记「做了什么」——做了什么在流程展示里。',
    '',
    rows.length ? table(['时间', '动作', '理由 / 依据'], rows) : '（暂无决策记录）',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ 根入口 */

function rootReadme(state, a) {
  return [
    `# ${state.title}`,
    '',
    `> ${state.goal || '（未填写目标）'}`,
    '',
    `阶段 ${a.stage}/4 · ${a.stageInfo.name}　｜　更新 ${state.updatedAt}`,
    '',
    '## 目录地图',
    '',
    '```',
    '├── README.md                     ← 你在这里',
    '├── human/                        ← 给人看的',
    '│   ├── 交流/                     ← 入口说明、决策记录',
    '│   ├── 流程展示/                 ← 00 总览 → 04 迭代分析',
    '│   ├── 成品/                     ← 最终方案',
    '│   └── 可验证中间过程/           ← 评分表 CSV、校验清单',
    '└── ai/                           ← 给 AI 用的，不要手改',
    '    ├── state.json                ← 唯一真相源',
    '    ├── index.json                ← 文件指纹',
    '    ├── evidence/sources.jsonl    ← 资料证据',
    '    └── log.jsonl                 ← 审计日志',
    '```',
    '',
    '## 三种读法',
    '',
    table(
      ['你想…', '读这份'],
      [
        ['只要结论', '[`human/成品/方案.md`](human/成品/方案.md)'],
        ['看我怎么推出来的', '[`human/流程展示/00-总览.md`](human/流程展示/00-总览.md) 起，按编号读'],
        ['验证数字对不对', '[`human/可验证中间过程/评分表.csv`](human/可验证中间过程/评分表.csv) + `research_task action=check`'],
      ],
    ),
    '',
    '`human/` 下的文件全部由 `ai/state.json` 渲染生成，手工修改会在下次 `check` 时被标记为不一致。',
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------------- API */

/** 渲染全部 human/ 文件，返回 { 相对路径: 内容 }。 */
export function renderAll(state, analysis) {
  return {
    'README.md': rootReadme(state, analysis),
    [HUMAN_PATHS.readme]: readme(state),
    [HUMAN_PATHS.decisions]: decisions(state),
    [HUMAN_PATHS.overview]: overview(state, analysis),
    [HUMAN_PATHS.collect]: collect(state, analysis),
    [HUMAN_PATHS.evaluate]: evaluate(state, analysis),
    [HUMAN_PATHS.fuse]: fuse(state, analysis),
    [HUMAN_PATHS.iterate]: iterate(state, analysis),
    [HUMAN_PATHS.deliverable]: deliverable(state, analysis),
    [HUMAN_PATHS.csv]: scoreCsv(state, analysis),
    [HUMAN_PATHS.checklist]: checklist(state, analysis),
  };
}
