/**
 * 能力探测层（纯函数：声明表 + 结果归一化，不碰子进程、不碰文件系统）。
 *
 * 为什么要有这一层：解题时最常问的不是「硬盘里有什么文件」，而是「这台机器能做什么」——
 * 装了哪个版本的 Python、conda 有几个环境、全局 npm 包有哪些、有没有 CUDA。
 * 这些信息的标准来源是包管理器自己的元数据，一次 `pip list --format=json` 就能拿到
 * 几百个库的准确版本，比扫一遍 site-packages 目录便宜几个数量级，也不会因为目录结构
 * 变化而失真。所以索引分两层：能力层走命令探测（本文件），内容层走文件树扫描（indexer.mjs）。
 *
 * 探测项分两档，理由同样是省资源：
 *   fast  —— 版本号类，几十毫秒，默认全跑；
 *   heavy —— 列包类，一次几秒到几十秒，只有 probe=full 才跑。
 */

export const CAP_VERSION = 1;

/** 版本号类命令：短超时、并行、缺了也不算错（没装就是没装，如实记进 missing）。 */
export const PROBES = [
  { id: 'node', label: 'Node.js', cmd: 'node', args: ['-v'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'bun', label: 'Bun', cmd: 'bun', args: ['--version'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'deno', label: 'Deno', cmd: 'deno', args: ['--version'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'python', label: 'Python', cmd: 'python', args: ['-V'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'python3', label: 'Python 3', cmd: 'python3', args: ['-V'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'node_path', label: 'Node 位置', cmd: 'node', args: ['-e', 'console.log(process.execPath)'], tier: 'fast', parse: 'line', kind: 'path' },
  { id: 'git', label: 'Git', cmd: 'git', args: ['--version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'java', label: 'Java', cmd: 'java', args: ['-version'], tier: 'fast', parse: 'version', kind: 'runtime', stderr: true },
  { id: 'javac', label: 'javac', cmd: 'javac', args: ['-version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'maven', label: 'Maven', cmd: 'mvn', args: ['-v'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'gradle', label: 'Gradle', cmd: 'gradle', args: ['-v'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'go', label: 'Go', cmd: 'go', args: ['version'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'rustc', label: 'Rust', cmd: 'rustc', args: ['--version'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'cargo', label: 'Cargo', cmd: 'cargo', args: ['--version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'dotnet', label: '.NET SDK', cmd: 'dotnet', args: ['--version'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'php', label: 'PHP', cmd: 'php', args: ['-v'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'ruby', label: 'Ruby', cmd: 'ruby', args: ['-v'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'Rscript', label: 'R', cmd: 'Rscript', args: ['-e', 'cat(R.version.string)'], tier: 'fast', parse: 'version', kind: 'runtime' },
  { id: 'ffmpeg', label: 'FFmpeg', cmd: 'ffmpeg', args: ['-version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'docker', label: 'Docker', cmd: 'docker', args: ['--version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'gcc', label: 'GCC', cmd: 'gcc', args: ['--version'], tier: 'fast', parse: 'version', kind: 'tool' },
  { id: 'cmake', label: 'CMake', cmd: 'cmake', args: ['--version'], tier: 'fast', parse: 'version', kind: 'tool' },
  {
    id: 'gpu',
    label: 'NVIDIA GPU',
    cmd: 'nvidia-smi',
    args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
    tier: 'fast',
    parse: 'lines',
    kind: 'hardware',
  },

  // heavy：列包。一个 pip list 在装了 500 个库的环境里约 2-5 秒。
  { id: 'npm_global', label: 'npm 全局包', cmd: 'npm', args: ['ls', '-g', '--json', '--depth=0'], tier: 'heavy', parse: 'npm', kind: 'packages' },
  { id: 'pnpm_global', label: 'pnpm 全局包', cmd: 'pnpm', args: ['ls', '-g', '--json', '--depth=0'], tier: 'heavy', parse: 'npm', kind: 'packages' },
  { id: 'pip', label: 'Python 库', cmd: 'python', args: ['-m', 'pip', 'list', '--format=json'], tier: 'heavy', parse: 'pip', kind: 'packages' },
  { id: 'conda_envs', label: 'Conda 环境', cmd: 'conda', args: ['env', 'list', '--json'], tier: 'heavy', parse: 'conda_envs', kind: 'packages' },
];

export const PROBE_BY_ID = new Map(PROBES.map((p) => [p.id, p]));

/** 单个探测的默认超时（毫秒）。heavy 慢是正常的，但不能无限等。 */
export function timeoutOf(probe) {
  return probe.tier === 'heavy' ? 30000 : 5000;
}

/**
 * 从任意命令输出里抽出版本号。`java -version` 会打两行，`go version` 会带平台名，
 * 所以不能整行取，只认第一个像版本号的 token。
 */
export function extractVersion(text) {
  if (!text) return '';
  const s = String(text);
  // 先削掉 v 前缀（`node -v` 输出 `v24.11.1`）。不削的话带 \b 的正则会从
  // 「24.11.1」内部切出「11.1」——字母和数字之间没有词边界，这是实测踩到的坑。
  const t = s.replace(/(^|[\s("'=])v(?=\d)/gi, '$1');
  const full = t.match(/\b\d+\.\d+(?:\.\d+)?(?:[-_.+][0-9A-Za-z.]+)?/);
  if (full) return full[0];
  // 只有一段的版本也要认：`javac 17`、`java version "17"` 就是这种。
  const one = t.match(/(?:^|[\s("'])(\d{1,3})(?=$|[\s"'.,)])/);
  return one ? one[1] : '';
}

/**
 * 容错解析 JSON。pip 会在 JSON 前面打一行升级提示，`npm ls -g` 可能带警告，
 * 所以不能直接 JSON.parse(text)：先找到第一个 `[` 或 `{`，再按括号配平切出完整的
 * 那一块。实测 pip 的输出是「JSON + 后面还有一行提示」，整体 parse 会报
 * `Unexpected non-whitespace character after JSON`。
 */
export function parseJsonLoose(text) {
  const s = String(text || '');
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('输出里没有 JSON');
  const from = Math.min(...starts);
  const open = s[from];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(from, i + 1));
    }
  }
  throw new Error('输出的 JSON 没有闭合');
}

function depsToPackages(deps) {
  if (!deps || typeof deps !== 'object') return [];
  return Object.entries(deps)
    .map(([name, v]) => ({ name, version: v && typeof v === 'object' ? String(v.version ?? '') : String(v ?? '') }))
    .filter((x) => x.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把一次命令执行的结果变成一条结构化记录。永远不抛：失败就是 `ok:false` + `why`。
 * 这样上层能诚实报告「哪些没探到、为什么」，而不是假装整台机器都摸清了。
 */
export function normalizeProbe(probe, run) {
  const out = { id: probe.id, label: probe.label, kind: probe.kind, ok: !!(run && run.ok) };
  const text = (run && (probe.stderr && !(run.stdout || '').trim() ? run.stderr : run.stdout)) || '';
  if (!out.ok) {
    out.why = (run && run.why) || '命令不在 PATH 或执行失败';
    return out;
  }
  try {
    switch (probe.parse) {
      case 'version': {
        out.version = extractVersion(text) || '未知';
        break;
      }
      case 'line': {
        out.value = String(text).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
        break;
      }
      case 'lines': {
        out.lines = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case 'npm': {
        const j = parseJsonLoose(text);
        out.packages = depsToPackages(j.dependencies);
        break;
      }
      case 'pip': {
        const j = parseJsonLoose(text);
        out.packages = (Array.isArray(j) ? j : [])
          .map((x) => ({ name: String(x.name ?? ''), version: String(x.version ?? '') }))
          .filter((x) => x.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        break;
      }
      case 'conda_envs': {
        const j = parseJsonLoose(text);
        out.envs = (Array.isArray(j.envs) ? j.envs : []).map((s) => String(s));
        break;
      }
      default: {
        out.raw = String(text).slice(0, 2000);
      }
    }
    out.ms = run.ms ?? 0;
    return out;
  } catch (e) {
    out.ok = false;
    out.why = `输出无法解析：${e.message}`;
    return out;
  }
}

/**
 * 汇总成人能读的能力画像。分开四组是因为它们的用处不同：
 * runtime 决定「用哪套语言跑」，packages 决定「不用装什么」，tool 决定「能做什么」，
 * hardware 决定「跑得动什么」。missing 单独列，因为「没装」本身也是解题信息。
 */
export function summarize(capabilities) {
  const items = Array.isArray(capabilities?.items) ? capabilities.items : [];
  const ok = items.filter((i) => i.ok);
  const by = (kind) => ok.filter((i) => i.kind === kind);
  const pkg = (id) => ok.find((i) => i.id === id)?.packages ?? [];

  const pkgGroups = [];
  for (const id of ['npm_global', 'pnpm_global', 'pip']) {
    const p = pkg(id);
    if (p.length) pkgGroups.push({ source: id, count: p.length, packages: p });
  }

  const envs = ok.find((i) => i.id === 'conda_envs')?.envs ?? [];

  return {
    probedAt: capabilities?.probedAt ?? '',
    host: capabilities?.host ?? {},
    runtimes: by('runtime').map((i) => ({ id: i.id, label: i.label, version: i.version ?? i.value ?? '' })),
    paths: by('path').map((i) => ({ id: i.id, label: i.label, path: i.value ?? '' })),
    tools: by('tool').map((i) => ({ id: i.id, label: i.label, version: i.version ?? '' })),
    hardware: by('hardware').map((i) => ({ id: i.id, label: i.label, lines: i.lines ?? [] })),
    packages: pkgGroups,
    condaEnvs: envs,
    missing: items.filter((i) => !i.ok).map((i) => ({ id: i.id, label: i.label, why: i.why ?? '' })),
    totalPackages: pkgGroups.reduce((n, g) => n + g.count, 0),
  };
}

/** 给「按名字找能力」用：能力层的检索不做模糊语义，只做大小写不敏感的子串匹配。 */
export function searchCapabilities(capabilities, query, { limit = 40 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const items = Array.isArray(capabilities?.items) ? capabilities.items : [];

  for (const it of items) {
    if (!it.ok) continue;
    const head = `${it.id} ${it.label}`.toLowerCase();
    if (head.includes(q)) hits.push({ area: 'probe', name: it.label, detail: it.version ?? it.value ?? '' });
    for (const p of it.packages ?? []) {
      if (String(p.name).toLowerCase().includes(q)) {
        hits.push({ area: 'package', name: p.name, detail: `${it.id}@${p.version}` });
        if (hits.length >= limit * 4) break;
      }
    }
    for (const e of it.envs ?? []) {
      if (String(e).toLowerCase().includes(q)) hits.push({ area: 'env', name: e, detail: 'conda 环境' });
    }
    if (hits.length >= limit * 4) break;
  }
  return hits.slice(0, limit);
}