/**
 * dsh-research-solver —— 科研式解题器。
 *
 * 三个工具：
 *   research_task  —— 建项目、收资料、记不足、定指标、登记候选、体检
 *   research_score —— 算分、冻结轮次快照、做轮次差分
 *   file_layout    —— 把目录整理成 human/（交流·流程展示·成品·可验证中间过程）与 ai/ 两棵树
 *
 * 设计约束（这个插件自己也遵守它宣传的原则）：
 *  · 没有引入任何外部依赖，评分全部是纯函数，同样的输入必然同样的输出；
 *  · 所有给人看的数字都能从 ai/state.json 复算回来，不允许「模型临场发挥的评价」；
 *  · 阶段由内容推导，不由人声明。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, nextId, analyze, snapshot, delta, pct } from './engine.mjs';
import { SKILL_MD } from './skill.mjs';
import {
  projectDir,
  exists,
  readState,
  saveProject,
  appendLog,
  checkIntegrity,
  listProjects,
  STATE_REL,
  walkFiles,
  writeFiles,
  moveInto,
  ensureDir,
  isDirectory,
} from './store.mjs';
import { FOLDER_IDS, classifyPath, folderOfKind, auditFiles, seedFiles, mapFiles } from './layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const name = 'dsh-research-solver';

export const inject = ['tools', 'skills'];

/** apply() 里注入的宿主上下文；execute 里拿不到 ctx，只能经由这里。 */
let hostCtx = null;

/* ------------------------------------------------------------------ 小工具 */

const now = () => new Date().toISOString();

function slugify(s) {
  const t = String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return t || 'project';
}

/** 丢掉 null/undefined 和空数组：输出模式里没有 required，缺字段比 null 安全。 */
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined) continue;
      const p = prune(x);
      if (Array.isArray(p) && p.length === 0) continue;
      o[k] = p;
    }
    return o;
  }
  return v;
}

function nextSteps(state, a) {
  const out = [];
  if (!state.sources.length) out.push('先 action=source 收集资料（先本地，tier 0–2）');
  if (!state.gaps.length) out.push('从资料里提炼不足：action=gap，每条都要 evidence');
  if (!state.metrics.length) out.push('定尺子：action=metric，写清方向与权重');
  if (!state.candidates.length) out.push('登记候选：action=candidate（至少两个才有比较）');
  if (state.candidates.length && state.metrics.length && !state.rounds.length)
    out.push('正式评估：research_score action=evaluate 冻结第一轮排名');
  const blocking = a.findings.filter((f) => f.level === 'error');
  if (blocking.length) out.push(`先清掉 ${blocking.length} 个阻塞项：${blocking.map((f) => f.code).join(', ')}`);
  if (a.stage === 2 && state.candidates.length >= 2 && !state.candidates.some((c) => c.kind === 'fused'))
    out.push('看 02 的矩阵，挑短板做融合方案：action=candidate kind=fused');
  if (a.stage === 3) out.push('融合方案登记后重新 evaluate，对比 03 的逐项变化');
  if (a.stage >= 2 && !state.chosen && a.top) out.push(`确认交付方案：action=choose chosen=${a.top.id}`);
  if (!out.length) out.push('自检通过，可以交付：human/成品/方案.md');
  return out;
}

/** 解析项目目录；未指定且只有一个项目时自动选中。 */
async function resolve(workspace, project) {
  if (project) return projectDir(workspace, slugify(project));
  const all = await listProjects(workspace);
  if (all.length === 1) return projectDir(workspace, all[0].slug);
  if (all.length === 0) throw new Error('还没有任何研究项目。先 research_task action=init。');
  throw new Error(`工作区有多个项目，请用 project= 指定：${all.map((p) => p.slug).join(', ')}`);
}

async function workspaceOf(exec) {
  const svc = hostCtx?.get?.('workingDirectory');
  try {
    if (svc && typeof svc.ensure === 'function') return await svc.ensure(exec.agent, exec.signal);
    if (svc && typeof svc.defaultDirectory === 'string') return svc.defaultDirectory;
  } catch {
    /* 落回进程目录 */
  }
  return process.cwd();
}

/* ----------------------------------------------------------------- 输出模式 */

const findingsSchema = {
  type: 'array',
  description: '确定性自检结果（error 必须清零才可交付）',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', description: '检查码，如 M001' },
      level: { type: 'string', description: 'error | warn | info' },
      message: { type: 'string', description: '问题描述' },
    },
  },
};

const taskOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    project: { type: 'string', description: '项目 slug' },
    dir: { type: 'string', description: '项目目录绝对路径' },
    stage: { type: 'integer', description: '当前阶段 1–4' },
    stageName: { type: 'string' },
    summary: { type: 'string', description: '这次调用改变了什么' },
    added: { type: 'array', items: { type: 'string' }, description: '新分配的 id' },
    files: { type: 'array', items: { type: 'string' }, description: '重写的文件（相对路径）' },
    findings: findingsSchema,
    missing: { type: 'array', items: { type: 'string' }, description: '还缺什么' },
    next: { type: 'array', items: { type: 'string' }, description: '建议的下一步' },
  },
};

const rankRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    total: { type: 'number', description: '加权总分 0..1' },
    rank: { type: 'integer' },
    complete: { type: 'boolean', description: '指标是否齐全' },
    pareto: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
  },
};

const deltaSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'integer' },
    to: { type: 'integer' },
    regressions: { type: 'array', items: { type: 'string' }, description: '分数下降的方案 id' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          before: { type: 'number' },
          after: { type: 'number' },
          diff: { type: 'number' },
          rankBefore: { type: 'integer' },
          rankAfter: { type: 'integer' },
        },
      },
    },
  },
};

const scoreOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    project: { type: 'string' },
    dir: { type: 'string' },
    stage: { type: 'integer' },
    stageName: { type: 'string' },
    round: { type: 'integer', description: '当前轮次' },
    summary: { type: 'string' },
    rows: { type: 'array', items: rankRowSchema, description: '按总分降序' },
    pareto: { type: 'array', items: { type: 'string' }, description: '帕累托前沿的方案 id' },
    localRatio: { type: 'number', description: '本地资料占比 0..1' },
    gapCoverage: { type: 'number', description: '不足覆盖率 0..1' },
    uncovered: { type: 'array', items: { type: 'string' }, description: '无人认领的不足 id' },
    delta: deltaSchema,
    findings: findingsSchema,
    missing: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
  },
};

function ranksOf(analysis) {
  return analysis.rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    total: r.total,
    rank: r.rank,
    complete: r.complete,
    pareto: r.pareto,
    missing: r.missing,
  }));
}

function deltaOf(d) {
  if (!d) return undefined;
  return {
    from: d.from,
    to: d.to,
    regressions: d.regressions,
    rows: d.rows.map((r) => ({
      id: r.id,
      name: r.name,
      after: r.after,
      ...(r.before !== null ? { before: r.before } : {}),
      ...(r.diff !== null ? { diff: r.diff } : {}),
      ...(r.rankBefore !== null ? { rankBefore: r.rankBefore } : {}),
      rankAfter: r.rankAfter,
    })),
  };
}

/* ------------------------------------------------------------------- 工具 1 */

const researchTask = defineTool({
  name: 'research_task',
  description:
    '科研式解题器的流程工具：建项目、登记资料与不足、定义评价指标、登记候选方案、选定交付方案、体检。' +
    '阶段按内容自动推进（有指标+候选→2，出现融合方案→3，两次评估→4）。' +
    '产物分两棵树：human/（交流·流程展示·成品·可验证中间过程）与 ai/（state.json 为唯一真相源）。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['init', 'status', 'source', 'gap', 'metric', 'candidate', 'choose', 'check'],
      description:
        'init=建项目；status=看进度；source=加资料；gap=加不足；metric=定指标；candidate=加候选；choose=选定；check=体检',
    },
    project: { type: 'string', description: '项目 slug（目录名）；init 可省略，由 title 生成' },
    title: { type: 'string', description: 'init：项目标题' },
    goal: { type: 'string', description: 'init：要解决的具体问题（一句话，可验收）' },
    sources: {
      type: 'array',
      description: 'source：资料条目。tier 0=工作区 1=本地知识库 2=本机应用 3=网络；tier≥3 必须写 whyLocalFailed',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tier: { type: 'integer', description: '0–3，越小越省资源' },
          kind: { type: 'string', description: 'paper | doc | code | issue | discussion | benchmark' },
          title: { type: 'string', required: true },
          locator: { type: 'string', description: '路径 / URL / DOI / 命令' },
          note: { type: 'string', description: '这条资料说了什么（一句话）' },
          whyLocalFailed: { type: 'string', description: 'tier≥3 时必填：本地为什么不够' },
        },
      },
    },
    gaps: {
      type: 'array',
      description: 'gap：别人的不足。创新点必须落在这里，每条都要指回资料 id',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: '谁做不好（方案 / 论文 / 工具名）' },
          gap: { type: 'string', required: true, description: '具体不足，不要写「不够好」' },
          evidence: { type: 'array', items: { type: 'string' }, description: '支撑该不足的资料 id，如 s-1' },
          impact: { type: 'string', description: '这个不足造成什么后果' },
        },
      },
    },
    metrics: {
      type: 'array',
      description: 'metric：评价指标（先定尺子再量东西）；同一次调用里全部登记',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          definition: { type: 'string', description: '怎么算出来的，要能被人复算' },
          direction: { type: 'string', enum: ['higher', 'lower'], description: '越高越好 / 越低越好' },
          weight: { type: 'number', description: '相对权重，内部按和归一化' },
        },
      },
    },
    replace: {
      type: 'boolean',
      description: 'metric：true = 清空旧指标重建（作废已有结论，check 会报 R001）',
    },
    candidate: {
      type: 'object',
      additionalProperties: false,
      description: 'candidate：一个候选方案',
      properties: {
        name: { type: 'string', required: true },
        kind: { type: 'string', enum: ['existing', 'fused'], description: 'existing=别人的方案；fused=你改进/融合出来的' },
        summary: { type: 'string', description: '方案本体：怎么做的' },
        strengths: { type: 'array', items: { type: 'string' } },
        weaknesses: { type: 'array', items: { type: 'string' }, description: '必须写：写不出缺点说明没看懂' },
        gapIds: { type: 'array', items: { type: 'string' }, description: '它补的是哪几条不足' },
        fuses: { type: 'array', items: { type: 'string' }, description: 'fused 必填：融合了哪些候选 id' },
        fixes: { type: 'array', items: { type: 'string' }, description: 'fused：具体补了哪条不足 / 哪个弱指标' },
        scores: {
          type: 'array',
          description: '0–10 原始分，按指标 id 给',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              metric: { type: 'string', required: true },
              value: { type: 'number', required: true },
              why: { type: 'string', description: '凭什么给这个分（可复核）' },
            },
          },
        },
      },
    },
    chosen: { type: 'string', description: 'choose：选定的候选 id，如 c-3' },
    note: { type: 'string', description: '写进 human/交流/决策记录.md 的「为什么」' },
  },
  output: {
    schema: taskOutputSchema,
    render(args, value) {
      const lines = [`**${value.stageName}**（阶段 ${value.stage}/4）· \`${value.project}\``, '', value.summary];
      if (value.added?.length) lines.push('', `新增：${value.added.join('、')}`);
      if (value.files?.length) lines.push('', `已写入 ${value.files.length} 个文件`);
      if (value.findings?.length) {
        lines.push('', '自检：');
        for (const f of value.findings) lines.push(`- \`${f.code}\` ${f.level} — ${f.message}`);
      }
      if (value.missing?.length) {
        lines.push('', '缺口：');
        for (const m of value.missing) lines.push(`- ${m}`);
      }
      if (value.next?.length) {
        lines.push('', '下一步：');
        for (const n of value.next) lines.push(`- ${n}`);
      }
      lines.push('', `产物目录：\`${value.dir}\``);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args, exec) {
    const workspace = await workspaceOf(exec);
    const stamp = now();

    if (args.action === 'init') {
      const slug = slugify(args.project || args.title || 'project');
      const dir = projectDir(workspace, slug);
      if (await exists(path.join(dir, STATE_REL))) {
        throw new Error(`项目 ${slug} 已存在：${dir}。换一个 project，或用 action=status 查看。`);
      }
      const state = emptyState({ slug, title: args.title || slug, goal: args.goal || '', now: stamp });
      state.decisions.push({ at: stamp, action: 'init', note: args.note || args.goal || '' });
      const { analysis, files } = await saveProject(dir, state);
      await appendLog(dir, { at: stamp, action: 'init', slug });
      return prune({
        ok: true,
        action: 'init',
        project: slug,
        dir,
        stage: analysis.stage,
        stageName: analysis.stageInfo.name,
        summary: `项目已建立：${state.title}。两棵文件树已生成，ai/state.json 是唯一真相源。`,
        files,
        next: nextSteps(state, analysis),
      });
    }

    const dir = await resolve(workspace, args.project);
    const state = await readState(dir);
    const added = [];

    if (args.action === 'status') {
      const analysis = analyze(state);
      return prune({
        ok: true,
        action: 'status',
        project: state.slug,
        dir,
        stage: analysis.stage,
        stageName: analysis.stageInfo.name,
        summary:
          `资料 ${state.sources.length} 条（本地占比 ${pct(analysis.local.ratio)}），` +
          `不足 ${state.gaps.length} 条（覆盖 ${pct(analysis.gap.ratio)}），` +
          `指标 ${state.metrics.length} 个，候选 ${state.candidates.length} 个，已评估 ${state.rounds.length} 轮。`,
        findings: analysis.findings,
        missing: analysis.missing,
        next: nextSteps(state, analysis),
      });
    }

    if (args.action === 'check') {
      const { analysis, issues } = await checkIntegrity(dir, state);
      const all = [...analysis.findings, ...issues];
      const blocking = all.filter((f) => f.level === 'error');
      return prune({
        ok: blocking.length === 0,
        action: 'check',
        project: state.slug,
        dir,
        stage: analysis.stage,
        stageName: analysis.stageInfo.name,
        summary:
          blocking.length === 0
            ? `体检通过：${all.length} 条提示，0 条阻塞。文件与状态逐字节一致。`
            : `体检未通过：${blocking.length} 条阻塞、${all.length - blocking.length} 条提示。`,
        findings: all,
        missing: analysis.missing,
        next: nextSteps(state, analysis),
      });
    }

    if (args.action === 'source') {
      const list = Array.isArray(args.sources) ? args.sources : [];
      if (!list.length) throw new Error('source 需要 sources 数组。');
      for (const s of list) {
        if (!String(s.title ?? '').trim()) throw new Error('每条资料都必须有 title。');
        const tier = Number.isInteger(s.tier) ? s.tier : s.kind === 'web' ? 3 : 0;
        if (tier < 0 || tier > 3) throw new Error(`tier 必须在 0..3：${tier}`);
        const id = nextId(state, 'source');
        state.sources.push({
          id,
          tier,
          kind: s.kind || 'doc',
          title: s.title.trim(),
          locator: s.locator || '',
          note: s.note || '',
          whyLocalFailed: s.whyLocalFailed || '',
          at: stamp,
        });
        added.push(id);
      }
      state.updatedAt = stamp;
      state.decisions.push({ at: stamp, action: 'source', note: args.note || `新增 ${list.length} 条资料` });
    } else if (args.action === 'gap') {
      const list = Array.isArray(args.gaps) ? args.gaps : [];
      if (!list.length) throw new Error('gap 需要 gaps 数组。');
      for (const g of list) {
        if (!String(g.gap ?? '').trim()) throw new Error('每条不足都必须写 gap（具体哪里做不好）。');
        const id = nextId(state, 'gap');
        state.gaps.push({
          id,
          target: g.target || '',
          gap: g.gap.trim(),
          evidence: Array.isArray(g.evidence) ? g.evidence : [],
          impact: g.impact || '',
          at: stamp,
        });
        added.push(id);
      }
      state.updatedAt = stamp;
      state.decisions.push({ at: stamp, action: 'gap', note: args.note || `新增 ${list.length} 条不足` });
    } else if (args.action === 'metric') {
      const list = Array.isArray(args.metrics) ? args.metrics : [];
      if (!list.length) throw new Error('metric 需要 metrics 数组。');
      if (args.replace) state.metrics = [];
      for (const m of list) {
        if (!String(m.name ?? '').trim()) throw new Error('每个指标都必须有 name。');
        const id = `m-${state.metrics.length + 1}`;
        state.metrics.push({
          id,
          name: m.name.trim(),
          definition: m.definition || '',
          direction: m.direction === 'lower' ? 'lower' : 'higher',
          weight: Number.isFinite(m.weight) ? m.weight : 10,
          at: stamp,
        });
        added.push(id);
      }
      state.metricsVersion = (state.metricsVersion || 0) + 1;
      state.updatedAt = stamp;
      state.decisions.push({
        at: stamp,
        action: 'metric',
        note: args.note || `${args.replace ? '重建' : '新增'} ${list.length} 个指标（v${state.metricsVersion}）`,
      });
    } else if (args.action === 'candidate') {
      const c = args.candidate;
      if (!c || !String(c.name ?? '').trim()) throw new Error('candidate 需要 candidate.name。');
      const kind = c.kind === 'fused' ? 'fused' : 'existing';
      const id = nextId(state, 'candidate');
      const scores = Array.isArray(c.scores) ? c.scores : [];
      for (const s of scores) {
        if (!state.metrics.some((m) => m.id === s.metric)) {
          throw new Error(
            `评分用了未登记指标 ${s.metric}。现有指标：${state.metrics.map((m) => m.id).join(', ') || '（无）'}`,
          );
        }
        if (!Number.isFinite(s.value) || s.value < 0 || s.value > 10) {
          throw new Error(`指标 ${s.metric} 的分值必须在 0..10，收到 ${s.value}`);
        }
      }
      if (kind === 'fused') {
        for (const f of c.fuses ?? []) {
          if (!state.candidates.some((x) => x.id === f)) throw new Error(`fused 引用了不存在的候选 ${f}。`);
        }
      }
      state.candidates.push({
        id,
        name: c.name.trim(),
        kind,
        summary: c.summary || '',
        strengths: Array.isArray(c.strengths) ? c.strengths : [],
        weaknesses: Array.isArray(c.weaknesses) ? c.weaknesses : [],
        gapIds: Array.isArray(c.gapIds) ? c.gapIds : [],
        fuses: Array.isArray(c.fuses) ? c.fuses : [],
        fixes: Array.isArray(c.fixes) ? c.fixes : [],
        scores: scores.map((s) => ({ metric: s.metric, value: s.value, why: s.why || '' })),
        round: state.rounds.length + 1,
        at: stamp,
      });
      added.push(id);
      state.updatedAt = stamp;
      state.decisions.push({ at: stamp, action: 'candidate', note: args.note || `新增候选 ${c.name}` });
    } else if (args.action === 'choose') {
      if (!args.chosen) throw new Error('choose 需要 chosen=<候选 id>。');
      if (!state.candidates.some((c) => c.id === args.chosen)) {
        throw new Error(`没有候选 ${args.chosen}。现有：${state.candidates.map((c) => c.id).join(', ')}`);
      }
      state.chosen = args.chosen;
      state.updatedAt = stamp;
      state.decisions.push({ at: stamp, action: 'choose', note: args.note || `选定 ${args.chosen}` });
    } else {
      throw new Error(`未知 action：${args.action}`);
    }

    const { analysis, files } = await saveProject(dir, state);
    await appendLog(dir, { at: stamp, action: args.action, added });

    const lead = added.length
      ? `已登记 ${added.join('、')}。`
      : args.action === 'choose'
        ? `已选定 ${state.chosen}。`
        : args.action === 'check'
          ? '已校验产物。'
          : '已更新状态。';

    return prune({
      ok: !analysis.findings.some((f) => f.level === 'error'),
      action: args.action,
      project: state.slug,
      dir,
      stage: analysis.stage,
      stageName: analysis.stageInfo.name,
      summary:
        lead +
        `当前 ${state.sources.length} 条资料 / ${state.gaps.length} 条不足 / ` +
        `${state.metrics.length} 个指标 / ${state.candidates.length} 个候选 / ${state.rounds.length} 轮评估。`,
      added,
      files,
      findings: analysis.findings,
      missing: analysis.missing,
      next: nextSteps(state, analysis),
    });
  },
});

/* ------------------------------------------------------------------- 工具 2 */

const researchScore = defineTool({
  name: 'research_score',
  description:
    '科研式解题器的确定性评分引擎：evaluate 冻结一轮排名快照；iterate 在改动后再冻结一轮并给出逐项差分；' +
    'compare 只复算当前排名不做快照。所有分数由 state.json 纯函数算出，可逐位复现。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['evaluate', 'iterate', 'compare'],
      description: 'evaluate=冻结第一/新一轮；iterate=改动后再评估并对比；compare=只复算',
    },
    project: { type: 'string', description: '项目 slug；只有一个项目时可省略' },
    hypothesis: { type: 'string', description: '这一轮想验证什么假设（evaluate/iterate 建议填写）' },
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: '这一轮改了什么（一次只改一类，否则分不清是尺子变还是东西变好）',
    },
    note: { type: 'string', description: '写进决策记录的补充说明' },
  },
  output: {
    schema: scoreOutputSchema,
    render(args, value) {
      const lines = [`**${value.stageName}**（阶段 ${value.stage}/4）· 第 ${value.round} 轮`, '', value.summary, ''];
      for (const r of value.rows ?? []) {
        const mark = r.pareto ? '◆' : ' ';
        const score = r.complete ? r.total.toFixed(3) : '不可比';
        lines.push(`${mark} ${r.rank}. ${r.name}（${r.id}）  ${score}`);
      }
      if (value.delta?.rows?.length) {
        lines.push('', `对比 R${value.delta.from} → R${value.delta.to}：`);
        for (const d of value.delta.rows) {
          const deltaText = d.diff === undefined ? '新增' : `${d.diff > 0 ? '+' : ''}${d.diff}`;
          lines.push(`- ${d.name}：${deltaText}（名次 ${d.rankBefore ?? '—'} → ${d.rankAfter ?? '—'}）`);
        }
        if (value.delta.regressions?.length) lines.push('', `**回归**：${value.delta.regressions.join('、')}`);
      }
      const bad = (value.findings ?? []).filter((f) => f.level === 'error');
      if (bad.length) {
        lines.push('', '阻塞项：');
        for (const f of bad) lines.push(`- \`${f.code}\` ${f.message}`);
      }
      lines.push('', `本地资料占比 ${pct(value.localRatio ?? 0)}；不足覆盖 ${pct(value.gapCoverage ?? 0)}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args, exec) {
    const workspace = await workspaceOf(exec);
    const dir = await resolve(workspace, args.project);
    const state = await readState(dir);
    const stamp = now();

    if (state.metrics.length === 0) throw new Error('还没有指标，无法评分。先 research_task action=metric。');
    if (state.candidates.length === 0) throw new Error('还没有候选方案，无法评分。先 research_task action=candidate。');

    if (args.action === 'compare') {
      const analysis = analyze(state);
      return prune({
        ok: !analysis.findings.some((f) => f.level === 'error'),
        action: 'compare',
        project: state.slug,
        dir,
        stage: analysis.stage,
        stageName: analysis.stageInfo.name,
        round: state.rounds.length,
        summary: `复算完成：${analysis.rows.length} 个候选，前沿 ${[...analysis.pareto].join('、') || '无'}。未冻结新快照。`,
        rows: ranksOf(analysis),
        pareto: [...analysis.pareto],
        localRatio: analysis.local.ratio,
        gapCoverage: analysis.gap.ratio,
        uncovered: analysis.gap.uncovered,
        delta: deltaOf(delta(state)),
        findings: analysis.findings,
        missing: analysis.missing,
        next: nextSteps(state, analysis),
      });
    }

    if (args.action === 'iterate' && state.rounds.length === 0) {
      throw new Error('还没有任何轮次，第一次请用 action=evaluate（iterate 用于第二轮及以后）。');
    }
    if (args.action === 'iterate' && !args.hypothesis) {
      throw new Error('iterate 需要 hypothesis：这一轮想验证什么，否则改动没有可解释性。');
    }

    const analysis = analyze(state);
    const round = snapshot(state, analysis, {
      hypothesis: args.hypothesis || '',
      changes: Array.isArray(args.changes) ? args.changes : [],
      now: stamp,
    });
    state.updatedAt = stamp;
    state.decisions.push({
      at: stamp,
      action: args.action,
      note: args.note || args.hypothesis || `第 ${round.n} 轮评估`,
    });

    const { analysis: after } = await saveProject(dir, state);
    await appendLog(dir, { at: stamp, action: args.action, round: round.n });

    const d = delta(state);
    const summary =
      args.action === 'iterate'
        ? `第 ${round.n} 轮已冻结。${
            d?.regressions.length
              ? `回归：${d.regressions.join('、')}——总分上涨可能掩盖单项下跌。`
              : '无单项回归。'
          }`
        : `第 ${round.n} 轮已冻结，排名可用于后续对比。`;

    return prune({
      ok: !after.findings.some((f) => f.level === 'error'),
      action: args.action,
      project: state.slug,
      dir,
      stage: after.stage,
      stageName: after.stageInfo.name,
      round: round.n,
      summary,
      rows: ranksOf(after),
      pareto: [...after.pareto],
      localRatio: after.local.ratio,
      gapCoverage: after.gap.ratio,
      uncovered: after.gap.uncovered,
      delta: deltaOf(d),
      findings: after.findings,
      missing: after.missing,
      next: nextSteps(state, after),
    });
  },
});

/* ------------------------------------------------------------------- 工具 3 */

const fileLayout = defineTool({
  name: 'file_layout',
  description:
    '文件治理：把任意目录整理成「给人用 / 给 AI 用」两棵树——human/{交流,流程展示,成品,可验证中间过程} 与 ai/。' +
    'init 建骨架与目录说明；audit 按确定性规则指出放错的文件；move 把它们挪回去（可一键全部）；map 重建人看的目录地图与机器索引。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['init', 'audit', 'move', 'map'],
      description: 'init=建骨架；audit=体检并给出去处；move=挪文件；map=重建目录地图与 ai/index.json',
    },
    root: {
      type: 'string',
      description: '要治理的目录，相对工作区；默认当前工作区根目录',
    },
    path: { type: 'string', description: 'move：要挪的文件（相对 root）' },
    kind: {
      type: 'string',
      description: 'move：强制指定去处，可用目录名（如 human/成品）或类型名（deliverable/evidence/stage/chat/machine）',
    },
    all: { type: 'boolean', description: 'move：把 audit 里所有高/中置信的放错文件一起挪走' },
    force: { type: 'boolean', description: 'init 覆盖已有文件 / move 覆盖同名目标；默认都不覆盖' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        root: { type: 'string' },
        summary: { type: 'string' },
        total: { type: 'integer', description: '扫描到的文件数' },
        misplaced: { type: 'integer', description: '放错且可自动归位的数量' },
        review: { type: 'integer', description: '低置信、需要人确认的数量' },
        strays: { type: 'integer', description: '散落在根目录的数量' },
        counts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              folder: { type: 'string' },
              count: { type: 'integer' },
            },
          },
          description: '每个格子现在（audit 后为建议去处）的文件数',
        },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              current: { type: 'string' },
              folder: { type: 'string' },
              kind: { type: 'string' },
              confidence: { type: 'string' },
              verdict: { type: 'string' },
              why: { type: 'string' },
            },
          },
          description: '需要处理的文件（status=ok 的不列出）',
        },
        moved: { type: 'array', items: { type: 'string' }, description: '本次挪动的 from → to' },
        files: { type: 'array', items: { type: 'string' }, description: '本次写入的文件' },
        next: { type: 'array', items: { type: 'string' } },
      },
    },
    render(args, v) {
      const lines = [`**文件治理 · ${v.action}**  \`${v.root}\``, '', v.summary];
      if (v.counts?.length) {
        lines.push('', '| 目录 | 文件数 |', '| --- | --- |');
        for (const c of v.counts) lines.push(`| \`${c.folder}/\` | ${c.count} |`);
      }
      if (v.rows?.length) {
        lines.push('', '| 文件 | 现在 | 建议 | 依据 |', '| --- | --- | --- | --- |');
        for (const r of v.rows) {
          const mark = r.verdict === 'move' ? '→' : r.verdict === 'root' ? '!' : '?';
          lines.push(`| \`${r.path}\` | ${r.current} | ${mark} \`${r.folder}\` | ${r.why} |`);
        }
      }
      if (v.moved?.length) {
        lines.push('', '已归位：');
        for (const m of v.moved) lines.push(`- ${m}`);
      }
      if (v.next?.length) {
        lines.push('', '下一步：');
        for (const n of v.next) lines.push(`- ${n}`);
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args, exec) {
    const workspace = await workspaceOf(exec);
    const rootArg = args.root ?? '.';
    const root = path.resolve(workspace, rootArg);
    if (args.action === 'init') {
      // 立骨架顺手建目录：新建一个项目时目录往往还不存在。
      if (!(await isDirectory(root))) await ensureDir(root);
    } else if (!(await isDirectory(root))) {
      throw new Error(`目录不存在：${root}`);
    }

    const stamp = now();
    const countsOf = (c) => Object.entries(c).map(([folder, count]) => ({ folder, count }));

    const audit = async () => {
      const { files, truncated } = await walkFiles(root);
      const result = auditFiles(root, files);
      return { ...result, truncated };
    };

    if (args.action === 'init') {
      const seed = seedFiles(stamp);
      const { written, skipped } = await writeFiles(root, seed, { overwrite: Boolean(args.force) });
      return prune({
        ok: true,
        action: 'init',
        root,
        summary:
          written.length > 0
            ? `已建骨架：写入 ${written.length} 个文件，跳过 ${skipped.length} 个已存在的（不覆盖）。`
            : `骨架已存在：${skipped.length} 个说明文件都在，什么都没改。用 force=true 才覆盖。`,
        files: written,
        counts: countsOf(Object.fromEntries(FOLDER_IDS.map((id) => [id, 0]))),
        next: [
          '把已有文件交进来体检：file_layout action=audit',
          '确认去处后一键归位：file_layout action=move all=true',
          '生成人看的目录地图：file_layout action=map',
        ],
      });
    }

    if (args.action === 'audit') {
      const a = await audit();
      const interesting = a.rows.filter((r) => r.verdict !== 'ok');
      return prune({
        ok: a.ok,
        action: 'audit',
        root,
        summary:
          a.total === 0
            ? '目录里还没有内容文件。先 init 建骨架，或把文件放进来。'
            : `扫描 ${a.total} 个文件：放错 ${a.misplaced} 个，待人工确认 ${a.low} 个，根目录游离 ${a.strays} 个。` +
              (a.truncated ? '（文件太多，只扫了前 2000 个）' : ''),
        total: a.total,
        misplaced: a.misplaced,
        review: a.low,
        strays: a.strays,
        counts: countsOf(a.counts),
        rows: interesting.slice(0, 60).map((r) => ({
          path: r.path,
          current: r.current,
          folder: r.folder,
          kind: r.kind,
          confidence: r.confidence,
          verdict: r.verdict,
          why: r.why,
        })),
        next: [
          a.misplaced ? '确认无误后：file_layout action=move all=true' : '',
          a.low ? '标了 ? 的文件靠名字判不出来，用 move path=... kind=... 指定' : '',
          a.strays ? '根目录只该留说明文件，其余都进格子' : '',
          '体检通过后：file_layout action=map 生成目录地图',
        ].filter(Boolean),
      });
    }

    if (args.action === 'move') {
      const moves = [];
      if (args.all) {
        const a = await audit();
        for (const r of a.rows) {
          // root = 散在根目录；move = 放进了错的格子。两者都该归位，
          // low（说不准的）留给人工，不替人做决定。
          if (r.verdict === 'move' || r.verdict === 'root') moves.push({ rel: r.path, folder: r.folder });
        }
        if (!moves.length) {
          return prune({
            ok: true,
            action: 'move',
            root,
            summary: '没有可自动归位的文件。低置信的请逐个用 path= + kind= 指定。',
            next: ['file_layout action=map'],
          });
        }
      } else {
        if (!args.path) throw new Error('move 需要 path=（或 all=true 一键归位）。');
        const rel = String(args.path).replace(/\\/g, '/').replace(/^\.\//, '');
        const target = FOLDER_IDS.includes(args.kind)
          ? args.kind
          : args.kind
            ? folderOfKind(args.kind)
            : classifyPath(rel).folder;
        moves.push({ rel, folder: target });
      }

      const done = [];
      const failed = [];
      for (const m of moves) {
        try {
          const r = await moveInto(root, m.rel, m.folder, { force: Boolean(args.force) });
          done.push(`${r.from} → ${r.to}`);
          await appendLog(root, { at: stamp, action: 'move', from: r.from, to: r.to });
        } catch (err) {
          failed.push(`${m.rel}：${err.message}`);
        }
      }

      const a = await audit();
      const map = mapFiles(root, a, stamp);
      const { written } = await writeFiles(root, map, { overwrite: true });

      return prune({
        ok: failed.length === 0,
        action: 'move',
        root,
        summary: `挪动 ${done.length} 个文件${failed.length ? `，${failed.length} 个失败` : ''}；已重建目录地图。`,
        total: a.total,
        misplaced: a.misplaced,
        review: a.low,
        strays: a.strays,
        counts: countsOf(a.counts),
        moved: done,
        files: written,
        next: failed.length ? [`先处理失败项：${failed.join('；')}`] : ['file_layout action=audit 复检'],
      });
    }

    if (args.action === 'map') {
      const a = await audit();
      const { written } = await writeFiles(root, mapFiles(root, a, stamp), { overwrite: true });
      return prune({
        ok: a.ok,
        action: 'map',
        root,
        summary: `已重建：human/README.md（人看的目录地图）与 ai/index.json（机器索引），覆盖 ${a.total} 个文件。`,
        total: a.total,
        misplaced: a.misplaced,
        review: a.low,
        strays: a.strays,
        counts: countsOf(a.counts),
        files: written,
        next: a.ok ? ['目录已整齐，可以交付'] : ['还有放错的文件：file_layout action=audit'],
      });
    }

    throw new Error(`未知 action：${args.action}`);
  },
});

/* ---------------------------------------------------------------------- 注册 */

export function apply(ctx) {
  hostCtx = ctx;
  ctx.tools.register(researchTask);
  ctx.tools.register(researchScore);
  ctx.tools.register(fileLayout);

  if (ctx.skills) {
    ctx.skills.register({
      name: 'research-solver',
      description:
        '科研式解题法：以别人的不足为创新点、先本地后联网、四阶段（资料→指标评估→融合改进→迭代）推进，' +
        '所有结论用确定性评分引擎复算；并把文件分成给人用的（交流·流程展示·成品·可验证中间过程）与给 AI 用的两棵树。' +
        '解一个复杂问题、或需要整理一堆文件时使用。',
      source: `plugin:${name}`,
      content: SKILL_MD,
      resourceBase: { kind: 'directory', path: HERE },
    });
  }
}
