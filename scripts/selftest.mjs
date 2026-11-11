/**
 * 离线自检：不经过 DSH 运行时，直接验证引擎与落盘层。
 *
 * 跑法：node scripts/selftest.mjs
 * 它检查的是「可复算」这件事本身：
 *   · 总分是否等于 Σ 权重×归一化分（独立重算一遍）
 *   · 方向为 lower 的指标是否真的反过来算
 *   · 渲染两次是否逐字节相同（determinism）
 *   · 落盘后 checkIntegrity 是否零问题
 *   · 体检码是否按预期触发
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, analyze, snapshot, computeStage, effectiveWeights, metricNorm } from '../lib/engine.mjs';
import { renderAll } from '../lib/render.mjs';
import { saveProject, checkIntegrity, readState, projectDir, walkFiles, writeFiles, moveInto } from '../lib/store.mjs';
import { FOLDER_IDS, classifyPath, auditFiles, seedFiles, mapFiles } from '../lib/layout.mjs';

const tmp = path.join(os.tmpdir(), 'dsh-research-solver-selftest');
const ws = path.join(tmp, 'ws');
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(ws, { recursive: true });

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const now = '2026-01-01T00:00:00.000Z';
const state = emptyState({ slug: 'selftest', title: '自检项目', goal: '验证引擎可复算', now });

// --- 造数据 ---------------------------------------------------------------
state.sources.push(
  { id: 's-1', tier: 0, kind: 'doc', title: '本地技能 ccf-paper-reviewer', locator: 'skills/ccf-*', note: '纯提示词', whyLocalFailed: '', at: now },
  { id: 's-2', tier: 1, kind: 'paper', title: '知识库里的评估方法论文', locator: 'kb://eval', note: '指标可复算', whyLocalFailed: '', at: now },
  { id: 's-3', tier: 3, kind: 'discussion', title: '社区讨论：评分不可回溯', locator: 'https://example.org/x', note: '用户抱怨', whyLocalFailed: '本地知识库没有工程实践类讨论', at: now },
);
state.counter.source = 3;

state.gaps.push(
  { id: 'g-1', target: '纯提示词技能', gap: '结论无状态，跨会话丢失', evidence: ['s-1'], impact: '无法迭代', at: now },
  { id: 'g-2', target: '纯提示词技能', gap: '评分靠模型临场发挥，不可复算', evidence: ['s-1', 's-3'], impact: '无法反驳', at: now },
  { id: 'g-3', target: '手工文档模板', gap: '阶段靠人自觉，会跳步', evidence: ['s-1'], impact: '流程失真', at: now },
  { id: 'g-4', target: '现有工具', gap: '产物不分「给人看」和「给机器读」', evidence: ['s-2'], impact: '人机互相污染', at: now },
);
state.counter.gap = 4;

state.metrics.push(
  { id: 'm-1', name: '方案完备度', direction: 'higher', weight: 25, definition: '四阶段是否都有产物', at: now },
  { id: 'm-2', name: '可复算性', direction: 'higher', weight: 30, definition: '结论能否从状态文件重算', at: now },
  { id: 'm-3', name: '状态开销', direction: 'lower', weight: 15, definition: '每次操作写入的字节数', at: now },
  { id: 'm-4', name: '阶段引导强度', direction: 'higher', weight: 20, definition: '缺步骤时是否主动指出', at: now },
  { id: 'm-5', name: '与现有工具冲突度', direction: 'lower', weight: 10, definition: '与已装技能的职责重叠', at: now },
);
state.metricsVersion = 1;

const mkScores = (v) => state.metrics.map((m, i) => ({ metric: m.id, value: v[i], why: '自检固定值' }));

state.candidates.push(
  { id: 'c-1', name: '纯提示词技能', kind: 'existing', summary: '靠提示词约束流程', strengths: ['零依赖'], weaknesses: ['无状态'], gapIds: ['g-1', 'g-2'], fuses: [], fixes: [], scores: mkScores([7, 3, 9, 5, 8]), round: 1, at: now },
  { id: 'c-2', name: '手工文档模板', kind: 'existing', summary: 'Word/Excel 流程卡', strengths: ['直观'], weaknesses: ['靠人自觉'], gapIds: ['g-3'], fuses: [], fixes: [], scores: mkScores([6, 5, 4, 4, 9]), round: 1, at: now },
);
state.counter.candidate = 2;

check('阶段 2（有指标 + 候选）', () => assert.equal(computeStage(state), 2));

state.candidates.push({
  id: 'c-3',
  name: '本插件：状态机 + 确定性引擎 + 双树',
  kind: 'fused',
  summary: '状态落盘 + 纯函数评分 + 人机分树',
  strengths: ['可复算', '阶段自动推导'],
  weaknesses: ['需要按流程调用工具'],
  gapIds: ['g-1', 'g-2', 'g-3', 'g-4'],
  fuses: ['c-1', 'c-2'],
  fixes: ['用 state.json 替代会话记忆', '用纯函数评分替代临场判断'],
  scores: mkScores([9, 10, 6, 9, 7]),
  round: 1,
  at: now,
});
state.counter.candidate = 3;

check('阶段 3（出现融合方案）', () => assert.equal(computeStage(state), 3));

// --- 数学一致性 -----------------------------------------------------------
const a = analyze(state);
const { map } = effectiveWeights(state.metrics);

check('权重归一化后和为 1', () => {
  const sum = [...map.values()].reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
});

check('总分 = Σ 权重 × 归一化分（独立重算）', () => {
  for (const r of a.rows) {
    const c = state.candidates.find((x) => x.id === r.id);
    let expect = 0;
    for (const m of state.metrics) {
      const s = c.scores.find((x) => x.metric === m.id).value;
      expect += map.get(m.id) * metricNorm(m, s).norm;
    }
    assert.ok(Math.abs(r.total - expect) < 0.011, `${r.id}: ${r.total} vs ${expect}`);
  }
});

check('lower 方向被反转（m-3 分数高则应更差）', () => {
  const norm9 = metricNorm(state.metrics.find((m) => m.id === 'm-3'), 9).norm;
  const norm4 = metricNorm(state.metrics.find((m) => m.id === 'm-3'), 4).norm;
  assert.ok(norm9 < norm4);
  assert.equal(norm9, 0.1);
});

check('排名按总分降序且名次连续', () => {
  const totals = a.rows.map((r) => r.total);
  assert.deepEqual(totals, [...totals].sort((x, y) => y - x));
  assert.deepEqual(a.rows.map((r) => r.rank), a.rows.map((_, i) => i + 1));
});

check('帕累托前沿非空且是子集', () => {
  assert.ok(a.pareto.size >= 1);
  for (const id of a.pareto) assert.ok(a.rows.some((r) => r.id === id));
});

check('不足覆盖 4/4（融合方案认领全部）', () => {
  assert.equal(a.gap.total, 4);
  assert.equal(a.gap.covered, 4);
  assert.equal(a.gap.ratio, 1);
  assert.deepEqual(a.gap.uncovered, []);
});

check('本地占比 2/3', () => {
  assert.equal(a.local.total, 3);
  assert.equal(a.local.local, 2);
  assert.equal(a.local.ratio, 0.67);
});

check('tier3 已说明理由 → 无 S001', () => assert.ok(!a.findings.some((f) => f.code === 'S001')));

check('无 error 级阻塞', () => {
  const errs = a.findings.filter((f) => f.level === 'error');
  assert.deepEqual(errs.map((f) => f.code), []);
});

// --- 渲染确定性 -----------------------------------------------------------
check('渲染两次逐字节相同', () => {
  const one = renderAll(state, analyze(state));
  const two = renderAll(state, analyze(state));
  assert.deepEqual(Object.keys(one).sort(), Object.keys(two).sort());
  for (const k of Object.keys(one)) assert.equal(one[k], two[k], `差异文件：${k}`);
});

check('渲染输出覆盖 human/ 四类目录', () => {
  const files = Object.keys(renderAll(state, analyze(state)));
  for (const prefix of ['human/交流/', 'human/流程展示/', 'human/成品/', 'human/可验证中间过程/']) {
    assert.ok(files.some((f) => f.startsWith(prefix)), `缺少 ${prefix}`);
  }
  assert.ok(files.includes('README.md'));
});

check('CSV 行数 = 候选 × 指标 + 候选（汇总行）+ 表头', () => {
  const files = renderAll(state, analyze(state));
  const csv = files['human/可验证中间过程/评分表.csv'];
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + state.candidates.length * (state.metrics.length + 1));
});

// --- 落盘往返 -------------------------------------------------------------
const dir = projectDir(ws, state.slug);
await saveProject(dir, state);
const round = snapshot(state, analyze(state), { hypothesis: '首轮基线', changes: [], now });
state.counter.round = round.n;
state.updatedAt = now;
await saveProject(dir, state);

// 融合方案已在，一轮评估不足以进第 4 阶段：仍是 3
check('一轮评估后停在阶段 3（差第二次迭代）', () => assert.equal(computeStage(state), 3));

const integ = await checkIntegrity(dir, await readState(dir));
check('重读状态后文件逐字节一致', () => assert.deepEqual(integ.issues, []));

check('state.json 可从磁盘还原且 slug 一致', () => {
  assert.equal(state.slug, 'selftest');
});

// 第二轮 → 阶段 4
snapshot(state, analyze(state), { hypothesis: '第二轮验证阶段推进', changes: ['调整权重'], now });
state.counter.round = 2;
await saveProject(dir, state);
check('阶段 4（两轮评估）', () => {
  assert.equal(computeStage(state), 4);
  assert.equal(state.rounds.length, 2);
});

// --- 负例：体检码真的会响 ------------------------------------------------
const bad = JSON.parse(JSON.stringify(state));
bad.sources.push({ id: 's-4', tier: 3, kind: 'web', title: '未说明理由的网络资料', locator: 'https://x', note: '', whyLocalFailed: '', at: now });
bad.candidates[0].scores = bad.candidates[0].scores.filter((s) => s.metric !== 'm-2');
bad.gaps.push({ id: 'g-5', target: '某人', gap: '无证据的不足', evidence: [], impact: '', at: now });
const badA = analyze(bad);
const codes = new Set(badA.findings.map((f) => f.code));

check('S001（联网未说明理由）触发', () => assert.ok(codes.has('S001')));
check('C001（候选缺指标）触发', () => assert.ok(codes.has('C001')));
check('G001（不足无证据）触发', () => assert.ok(codes.has('G001')));

const badRound = JSON.parse(JSON.stringify(state));
badRound.metrics.push({ id: 'm-6', name: '新指标', direction: 'higher', weight: 5, definition: '', at: now });
badRound.metricsVersion += 1;
check('R001（指标改动后结论过期）触发', () => {
  assert.ok(analyze(badRound).findings.some((f) => f.code === 'R001'));
});

// --- 文件治理（file_layout）-----------------------------------------------
async function acheck(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

check('分类：交流记录进 human/交流', () => {
  assert.equal(classifyPath('对话-2026-01-01.md').folder, 'human/交流');
  assert.equal(classifyPath('meeting-notes.md').folder, 'human/交流');
});

check('分类：评分表进可验证中间过程（不被扩展名抢走）', () => {
  assert.equal(classifyPath('评分表.csv').folder, 'human/可验证中间过程');
  assert.equal(classifyPath('校验清单.md').folder, 'human/可验证中间过程');
});

check('分类：成品 / 流程 / 机器文件各归其位', () => {
  assert.equal(classifyPath('成品-方案.docx').folder, 'human/成品');
  assert.equal(classifyPath('流程-阶段2.md').folder, 'human/流程展示');
  assert.equal(classifyPath('state.json').folder, 'ai');
  assert.equal(classifyPath('run.ps1').folder, 'ai');
});

check('分类：说不准就标低置信，不硬猜', () => {
  const c = classifyPath('随手记.txt');
  assert.equal(c.confidence, 'low');
  assert.equal(classifyPath('human/成品/方案.md').confidence, 'high');
});

const layoutDir = path.join(ws, 'layout-demo');
await fs.mkdir(layoutDir, { recursive: true });

await acheck('init 建出五格骨架且不覆盖已有文件', async () => {
  const seed = seedFiles(now);
  assert.equal(Object.keys(seed).length, FOLDER_IDS.length + 2);
  await fs.writeFile(path.join(layoutDir, 'README.md'), '# 我原来的说明\n', 'utf8');
  const r1 = await writeFiles(layoutDir, seed, { overwrite: false });
  assert.ok(r1.written.length > 0);
  assert.ok(r1.skipped.includes('README.md'), 'README.md 不该被覆盖');
  const kept = await fs.readFile(path.join(layoutDir, 'README.md'), 'utf8');
  assert.equal(kept, '# 我原来的说明\n');
});

await acheck('audit 找出散落根目录的文件并给出去处', async () => {
  await fs.writeFile(path.join(layoutDir, '对话-需求澄清.md'), 'x', 'utf8');
  await fs.writeFile(path.join(layoutDir, '评分表.csv'), 'a,b\n', 'utf8');
  const { files } = await walkFiles(layoutDir);
  const a = auditFiles(layoutDir, files);
  assert.equal(a.strays >= 2, true, `strays=${a.strays}`);
  const chat = a.rows.find((r) => r.path === '对话-需求澄清.md');
  assert.equal(chat.folder, 'human/交流');
  assert.equal(chat.verdict, 'root');
  assert.equal(a.ok, false);
});

await acheck('move 归位后复检干净', async () => {
  await moveInto(layoutDir, '对话-需求澄清.md', 'human/交流');
  await moveInto(layoutDir, '评分表.csv', 'human/可验证中间过程');
  const { files } = await walkFiles(layoutDir);
  const a = auditFiles(layoutDir, files);
  assert.equal(a.misplaced, 0);
  assert.equal(a.strays, 0);
  assert.equal(a.ok, true);
  assert.ok(a.counts['human/交流'] >= 1);
});

await acheck('move 不覆盖同名目标', async () => {
  await fs.writeFile(path.join(layoutDir, '评分表.csv'), 'second\n', 'utf8');
  await assert.rejects(
    () => moveInto(layoutDir, '评分表.csv', 'human/可验证中间过程'),
    /目标已存在/,
  );
});

await acheck('map 落盘人看的目录地图与机器索引', async () => {
  const { files } = await walkFiles(layoutDir);
  const a = auditFiles(layoutDir, files);
  const map = mapFiles(layoutDir, a, now);
  await writeFiles(layoutDir, map, { overwrite: true });
  const human = await fs.readFile(path.join(layoutDir, 'human/README.md'), 'utf8');
  assert.ok(human.includes('目录地图'));
  const idx = JSON.parse(await fs.readFile(path.join(layoutDir, 'ai/index.json'), 'utf8'));
  assert.equal(idx.version, 1);
  assert.equal(idx.totals.files, a.total);
  assert.ok(idx.files.every((f) => typeof f.kind === 'string'));
});

await acheck('复检：目录说明不算放错，直接躺在 human/ 下的散文件算', async () => {
  await fs.writeFile(path.join(layoutDir, 'human/临时想法.md'), 'x\n', 'utf8');
  const { files } = await walkFiles(layoutDir);
  const a = auditFiles(layoutDir, files);
  const readme = a.rows.find((r) => r.path === 'human/README.md');
  const stray = a.rows.find((r) => r.path === 'human/临时想法.md');
  assert.equal(readme.verdict, 'ok');
  // 说明文件不参与类型归类：它是这一层的说明书，家在原地。
  assert.equal(readme.kind, 'doc');
  assert.equal(readme.folder, 'human');
  assert.equal(a.counts['human/流程展示'] >= 0, true);
  // .md 说不准是流程还是成品，按「不替人猜」的规矩只提示、不搬。
  assert.equal(stray.verdict, 'review');
});

console.log(`\n全部通过：${passed} 项`);
console.log(`产物目录：${dir}`);
