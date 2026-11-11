/**
 * 文件治理层：把「给人用 / 给 AI 用」的分法变成可执行、可复核的规则。
 *
 * 纯函数：分类只看路径与扩展名，渲染只看传入的清单。
 * 没有「模型觉得应该放哪」这一步——放错了要能被指出来，改起来要能一键。
 */

export const LAYOUT_VERSION = 1;

/** 五个去处。顺序即展示顺序。 */
export const FOLDERS = [
  {
    id: 'human/交流',
    side: 'human',
    kind: 'chat',
    title: '交流',
    purpose: '人与 AI 之间的往返：需求澄清、追问、取舍讨论、会议纪要、邮件。',
    exclude: '结论正文（去「成品」）、原始数据（去「可验证中间过程」）',
    naming: 'YYYYMMDD-主题.md',
    reader: '当事人',
  },
  {
    id: 'human/流程展示',
    side: 'human',
    kind: 'stage',
    title: '流程展示',
    purpose: '过程本身：阶段报告、进度、计划、流程图、怎么一步步走到结论的。',
    exclude: '已经定稿的交付物（去「成品」）',
    naming: 'NN-阶段名.md（编号即顺序）',
    reader: '评审者 / 接手的人',
  },
  {
    id: 'human/成品',
    side: 'human',
    kind: 'deliverable',
    title: '成品',
    purpose: '可以直接拿去用的东西：方案、报告、文档、演示、成图。',
    exclude: '半成品与草稿（留在「流程展示」）',
    naming: '直接用它的名字，不要加日期',
    reader: '使用者',
  },
  {
    id: 'human/可验证中间过程',
    side: 'human',
    kind: 'evidence',
    title: '可验证中间过程',
    purpose: '能被机器或人重新算一遍的东西：评分表、校验清单、原始数据、日志、证据截图。',
    exclude: '叙述性总结（去「流程展示」）',
    naming: '与它证明的结论同名，便于对照',
    reader: '怀疑者',
  },
  {
    id: 'ai',
    side: 'ai',
    kind: 'machine',
    title: 'AI 工作区',
    purpose: '给 AI 读写的结构化文件：状态、索引、日志、脚本、缓存。人不需要读。',
    exclude: '任何需要人读的正文（去 human/）',
    naming: '小写-短横线，扩展名说明格式',
    reader: 'AI',
  },
];

export const FOLDER_IDS = FOLDERS.map((f) => f.id);
export const HUMAN_IDS = FOLDERS.filter((f) => f.side === 'human').map((f) => f.id);
export const KINDS = [...new Set(FOLDERS.map((f) => f.kind))];

export function folderMeta(id) {
  return FOLDERS.find((f) => f.id === id) ?? null;
}

export function folderOfKind(kind) {
  const f = FOLDERS.find((x) => x.kind === kind);
  return f ? f.id : 'human/流程展示';
}

/* ------------------------------------------------------------------ 分类规则 */

/**
 * 先看名字里的意图词，再看扩展名。第一条命中的规则说了算，所以顺序有含义：
 * 「对话记录.json」算交流，「评分表.csv」算证据，都不让扩展名抢走。
 */
const RULES = [
  {
    kind: 'chat',
    label: '名字像交流记录',
    re: /(对话|问答|会议|纪要|邮件|讨论记录|chat|transcript|conversation|meeting|email|thread)/i,
  },
  {
    kind: 'evidence',
    label: '名字像可复算证据',
    re: /(评分|打分|校验|体检|清单|证据|原始|溯源|复算|score|checklist|evidence|trace|raw|metrics|verification)/i,
  },
  {
    kind: 'stage',
    label: '名字像过程文档',
    re: /(流程|阶段|进度|计划|路线|过程|总览|stage|flow|plan|roadmap|progress|step)/i,
  },
  {
    kind: 'deliverable',
    label: '名字像交付物',
    re: /(成品|交付|定稿|最终|方案|报告|final|deliverable|release)/i,
  },
];

/** 扩展名兜底：高置信（格式本身说明用途）。 */
const EXT_HIGH = new Map([
  ['jsonl', 'evidence'],
  ['ndjson', 'evidence'],
  ['log', 'evidence'],
  ['csv', 'evidence'],
  ['tsv', 'evidence'],
  ['har', 'evidence'],
  ['json', 'machine'],
  ['yaml', 'machine'],
  ['yml', 'machine'],
  ['toml', 'machine'],
  ['lock', 'machine'],
  ['sqlite', 'machine'],
  ['db', 'machine'],
  ['py', 'machine'],
  ['mjs', 'machine'],
  ['js', 'machine'],
  ['ts', 'machine'],
  ['sh', 'machine'],
  ['ps1', 'machine'],
  ['bat', 'machine'],
  ['cmd', 'machine'],
  ['ipynb', 'machine'],
  ['docx', 'deliverable'],
  ['pptx', 'deliverable'],
  ['key', 'deliverable'],
  ['epub', 'deliverable'],
]);

/** 扩展名兜底：低置信（同一种格式两边都可能）。 */
const EXT_LOW = new Map([
  ['md', 'stage'],
  ['txt', 'stage'],
  ['pdf', 'deliverable'],
  ['png', 'deliverable'],
  ['jpg', 'deliverable'],
  ['jpeg', 'deliverable'],
  ['gif', 'deliverable'],
  ['webp', 'deliverable'],
  ['svg', 'deliverable'],
  ['drawio', 'stage'],
  ['html', 'deliverable'],
  ['xlsx', 'evidence'],
  ['xls', 'evidence'],
]);

function extOf(rel) {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i + 1).toLowerCase();
}

function baseOf(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

/** 这个路径现在实际待在哪个格子里：'' 表示根目录。 */
export function currentFolder(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const hit = FOLDER_IDS.find((id) => p === id || p.startsWith(`${id}/`));
  if (hit) return hit;
  const seg = p.split('/')[0];
  return p.includes('/') && seg ? seg : '';
}

/**
 * 分类一个相对路径。
 * @returns {{kind:string, folder:string, confidence:'high'|'medium'|'low', why:string}}
 */
export function classifyPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const inside = currentFolder(p);
  if (FOLDER_IDS.includes(inside)) {
    const meta = folderMeta(inside);
    return { kind: meta.kind, folder: inside, confidence: 'high', why: '已经在该目录内' };
  }

  const name = baseOf(p);
  for (const rule of RULES) {
    if (rule.re.test(name)) {
      return { kind: rule.kind, folder: folderOfKind(rule.kind), confidence: 'medium', why: rule.label };
    }
  }

  const ext = extOf(p);
  if (EXT_HIGH.has(ext)) {
    return {
      kind: EXT_HIGH.get(ext),
      folder: folderOfKind(EXT_HIGH.get(ext)),
      confidence: 'high',
      why: `扩展名 .${ext}`,
    };
  }
  if (EXT_LOW.has(ext)) {
    return {
      kind: EXT_LOW.get(ext),
      folder: folderOfKind(EXT_LOW.get(ext)),
      confidence: 'low',
      why: `扩展名 .${ext} 不唯一，需人工确认`,
    };
  }
  return { kind: 'stage', folder: 'human/流程展示', confidence: 'low', why: '无规则命中，按过程文档暂放' };
}

/* -------------------------------------------------------------------- 体检 */

/** 根目录唯一合法的东西：说明自己是干什么的那份文件。 */
const ROOT_ALLOW = /^(readme|license|changelog|contributing|说明|目录|索引)(\.[a-z]+)?$/i;

/**
 * @param {string} root 目录名，仅用于输出
 * @param {Array<{rel:string, bytes:number}>} files
 */
export function auditFiles(root, files) {
  const rows = [];
  const counts = Object.fromEntries(FOLDER_IDS.map((id) => [id, 0]));
  let misplaced = 0;
  let low = 0;
  let strays = 0;

  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const cur = currentFolder(f.rel);
    // 说明文件不参与「按类型归类」：它就是这一层自己的说明书，家在原地。
    const isDoc = ROOT_ALLOW.test(baseOf(f.rel)) && (cur === '' || cur === 'human' || cur === 'ai');
    const c = isDoc
      ? {
          kind: 'doc',
          folder: cur,
          confidence: 'high',
          why: '目录说明文件：它说明这一层干什么，就住这一层',
        }
      : classifyPath(f.rel);
    if (counts[c.folder] !== undefined) counts[c.folder] += 1;

    let verdict = 'ok';
    if (isDoc) {
      verdict = 'ok';
    } else if (cur === '') {
      // 根目录只放「这堆文件是干什么的」那份说明，其余一律算游离。
      if (c.confidence === 'low') {
        // 说不准的别替人搬：搬错了比放着更贵。
        verdict = 'review';
        low += 1;
      } else {
        verdict = 'root';
        strays += 1;
      }
    } else if (cur === c.folder) {
      verdict = 'ok';
    } else if (cur === 'human' || cur === 'ai') {
      // 直接躺在两棵树根上的文件，是「还没决定归哪格」。
      if (c.confidence === 'low') {
        verdict = 'review';
        low += 1;
      } else {
        verdict = 'move';
        misplaced += 1;
      }
    } else {
      verdict = c.confidence === 'low' ? 'review' : 'move';
      if (verdict === 'move') misplaced += 1;
      else low += 1;
    }

    rows.push({
      path: f.rel,
      bytes: f.bytes ?? 0,
      current: cur || '（根目录）',
      kind: c.kind,
      folder: c.folder,
      confidence: c.confidence,
      verdict,
      why: c.why,
    });
  }

  return {
    root,
    rows,
    counts,
    total: rows.length,
    misplaced,
    low,
    strays,
    ok: misplaced === 0 && strays === 0,
  };
}

/* -------------------------------------------------------------------- 渲染 */

function table(head, rows) {
  const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

export function renderFolderReadme(f) {
  return `# ${f.title}

> ${f.purpose}

- **谁读**：${f.reader}
- **不放什么**：${f.exclude}
- **命名**：${f.naming}
- **上级**：${f.side === 'ai' ? '这一层只有 AI 会读，人不需要进来。' : '本目录属于 human/，由人阅读；机器可读的真相在 ai/。'}
`;
}

export function renderSideReadme() {
  const rows = HUMAN_IDS.map((id) => {
    const f = folderMeta(id);
    return [`\`${id.split('/').pop()}/\``, f.title, f.purpose, f.reader];
  });
  return `# human/ —— 给人看的部分

一份材料只回答一个问题。找不到就去问，不要在错误的目录里将就。

${table(['目录', '名字', '放什么', '谁读'], rows)}

## 三条约定

1. **一个结论只有一个出处。** 成品里的话要是和过程文档冲突，以成品为准，然后回头改过程文档。
2. **能复算的放「可验证中间过程」。** 放进去就意味着：别人拿它可以重算出同样的数。
3. **不要在这里手改机器生成的表格。** 手改过的表格下次生成就被覆盖，且会被标记为不一致。

机器读的那份在 \`ai/\`，两边不同步就是故障。
`;
}

export function renderRootReadme(counts, stamp) {
  const rows = FOLDERS.map((f) => [`\`${f.id}/\``, f.title, f.purpose, String(counts[f.id] ?? 0)]);
  return `# 目录约定

这个目录把文件分成**给人用的**和**给 AI 用的**；给人用的再按「你在什么阶段需要它」分四格。

${table(['目录', '名字', '放什么', '现有'], rows)}

## 为什么这么分

- **AI 读结构化、人读叙述**。混在一起时，AI 要解析自然语言，人要去读状态文件，两边都在猜。
- **过程与成品分开**。成品会被改，过程不该跟着变；过程被改，成品要重新审。
- **可验证的东西单独放**。评分表、校验清单这类文件的价值在于能被重算，混进正文就没人算了。

## 复检

\`file_layout action=audit root=.\` 会指出放错的文件；\`action=map\` 重新生成这份索引。

最后整理：${stamp || '—'}
`;
}

export function renderHumanMap(root, audit, stamp) {
  const byFolder = new Map(FOLDER_IDS.map((id) => [id, []]));
  for (const r of audit.rows) {
    const slot = byFolder.get(r.current === '（根目录）' ? '' : r.current);
    if (slot) slot.push(r);
  }

  const lines = [
    '# 目录地图',
    '',
    '> 30 秒内找到该看的东西，而不是翻聊天记录。',
    '',
    table(
      ['目录', '放什么', '现有'],
      FOLDERS.map((f) => [`\`${f.id}/\``, f.purpose, String(audit.counts[f.id] ?? 0)]),
    ),
    '',
  ];

  for (const id of FOLDER_IDS) {
    const items = byFolder.get(id) ?? [];
    if (!items.length) continue;
    lines.push(`## ${id}/`, '');
    for (const r of items.slice(0, 40)) {
      lines.push(`- \`${r.path.split('/').slice(-1)[0]}\` — ${r.bytes} B`);
    }
    if (items.length > 40) lines.push(`- …还有 ${items.length - 40} 个`);
    lines.push('');
  }

  const stray = audit.rows.filter((r) => r.verdict === 'root');
  if (stray.length) {
    lines.push('## 还没归位（在根目录）', '');
    for (const r of stray) lines.push(`- \`${r.path}\` → 建议去 \`${r.folder}/\``);
    lines.push('');
  }

  lines.push(`共 ${audit.total} 个文件；放错 ${audit.misplaced}；待确认 ${audit.low}；根目录游离 ${audit.strays}。`);
  lines.push('', `最后生成：${stamp || '—'}`);
  return `${lines.join('\n')}\n`;
}

export function renderAiIndex(root, audit, stamp) {
  return `${JSON.stringify(
    {
      version: LAYOUT_VERSION,
      root,
      generatedAt: stamp || null,
      folders: FOLDERS.map((f) => ({ id: f.id, kind: f.kind, count: audit.counts[f.id] ?? 0 })),
      totals: {
        files: audit.total,
        misplaced: audit.misplaced,
        review: audit.low,
        strays: audit.strays,
      },
      files: audit.rows.map((r) => ({
        path: r.path,
        folder: r.folder || null,
        current: r.current,
        kind: r.kind,
        confidence: r.confidence,
        verdict: r.verdict,
        bytes: r.bytes,
      })),
    },
    null,
    2,
  )}\n`;
}

/** init 落盘的种子文件：根约定 + 五格说明。 */
export function seedFiles(stamp) {
  const out = { 'human/README.md': renderSideReadme() };
  for (const f of FOLDERS) out[`${f.id}/README.md`] = renderFolderReadme(f);
  out['README.md'] = renderRootReadme({}, stamp);
  return out;
}

/** map 落盘：human/README.md 换成带清单的版本，ai/index.json 是机器索引。 */
export function mapFiles(root, audit, stamp) {
  return {
    'human/README.md': renderHumanMap(root, audit, stamp),
    'ai/index.json': renderAiIndex(root, audit, stamp),
  };
}
