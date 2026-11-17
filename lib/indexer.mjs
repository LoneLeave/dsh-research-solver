/**
 * 内容索引层（纯函数：跳过规则、文件分类、查询匹配、摘要渲染）。
 *
 * 设计取向与 probe.mjs 互补：能力层回答「能做什么」，这一层回答「手头有什么」。
 * 两个刻意的取舍：
 *
 *   1. 默认跳过依赖目录（node_modules / site-packages / .m2 …）。这些目录动辄几十万文件，
 *      而它们的版本信息在能力层已经从包管理器拿到了准确答案——扫它们只会把索引撑爆、
 *      却提供不了新信息。真要扫可以传 includeDeps。
 *   2. 跳过一律计数并回报。用户要的是「全部资源」，所以「没索引到什么、为什么没索引」
 *      必须能看见，不能假装扫全了。
 */

export const INDEX_VERSION = 1;

/** 依赖与缓存目录：版本信息在能力层已有，文件层跳过它们省下的不是一点。 */
export const DEP_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages',
  'site-packages', 'dist-packages', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  '.venv', 'venv', '.virtualenv',
  '.git', '.svn', '.hg', '.bzr',
  '.gradle', '.m2', '.cargo', '.rustup', '.nuget', '.cocoapods',
  '.cache', '.parcel-cache', '.next', '.nuxt', '.svelte-kit', '.turbo', '.angular', '.vite',
  'dist', 'build', 'obj', 'out', '.tox', '.conda', 'pkgs',
  '.idea', '.vs', '.vscode-test',
]);

/** 系统与回收站：扫了没用，还常因权限中断整次扫描。 */
export const SYSTEM_DIRS = new Set([
  'windows', 'winsxs', '$recycle.bin', 'system volume information', 'recovery', 'perflogs',
  'windowspowershell', 'installer', 'driverstore',
]);

/** AppData 下这些子树是纯缓存。 */
export const CACHE_DIRS = new Set(['temp', 'tmp', 'cache', 'caches', 'package cache', 'crashdumps', 'inetcache']);

export const SKIP_FILES = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'desktop.ini', '.ds_store', 'thumbs.db']);

/** 单文件超过这个大小默认只记不细看（我们本来也不读内容，只是避免把巨型镜像算进「文档」）。 */
export const BIG_FILE_BYTES = 8 * 1024 * 1024 * 1024;

const KIND_BY_EXT = new Map(
  Object.entries({
    // 代码
    code: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'pyi', 'pyx', 'ipynb', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'r', 'jl', 'm', 'mm', 'swift', 'dart', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'vue', 'astro', 'elm', 'ex', 'exs', 'erl', 'hs', 'clj', 'zig', 'nim', 'v', 'asm', 's'],
    // 文字
    text: ['md', 'markdown', 'txt', 'rst', 'org', 'log', 'tex', 'latex', 'bib', 'adoc', 'rtf', 'nfo', 'readme'],
    // PDF
    pdf: ['pdf', 'djvu', 'epub', 'mobi', 'azw3'],
    // 办公文档
    doc: ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key'],
    // 图片
    image: ['png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'heif', 'avif', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'dng'],
    // 视频
    video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'vob', '3gp', 'ogv', 'rmvb', 'rm'],
    // 音频
    audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'wma', 'opus', 'aiff', 'ape', 'mid', 'midi'],
    // 结构化数据
    data: ['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'parquet', 'arrow', 'feather', 'sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'avro', 'orc', 'proto', 'ini', 'conf', 'cfg', 'env', 'properties', 'plist', 'reg'],
    // 模型权重
    model: ['pt', 'pth', 'ckpt', 'safetensors', 'onnx', 'h5', 'hdf5', 'pb', 'tflite', 'gguf', 'ggml', 'pkl', 'joblib', 'npy', 'npz', 'mat', 'bin'],
    // 压缩包
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'cab', 'iso', 'dmg', 'jar', 'war', 'whl', 'egg', 'apk', 'msi', 'deb', 'rpm', 'pkg'],
    // 可执行与库
    binary: ['exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'pdb', 'sys', 'drv', 'class', 'pyc', 'pyd', 'node', 'wasm'],
  }).flatMap(([kind, exts]) => exts.map((e) => [e, kind])),
);

/** 用户点名的四类（视频/图片/文字/PDF）要能当过滤条件直接写，不必记扩展名。 */
export const KIND_ALIASES = new Map([
  ['video', 'video'], ['视频', 'video'], ['影片', 'video'],
  ['image', 'image'], ['img', 'image'], ['picture', 'image'], ['图片', 'image'], ['图像', 'image'], ['照片', 'image'],
  ['text', 'text'], ['文字', 'text'], ['文本', 'text'], ['文档', 'text'],
  ['pdf', 'pdf'],
  ['doc', 'doc'], ['office', 'doc'], ['办公', 'doc'],
  ['code', 'code'], ['源码', 'code'], ['代码', 'code'],
  ['audio', 'audio'], ['音频', 'audio'], ['music', 'audio'], ['音乐', 'audio'],
  ['data', 'data'], ['数据', 'data'],
  ['model', 'model'], ['模型', 'model'], ['权重', 'model'],
  ['archive', 'archive'], ['压缩包', 'archive'],
  ['binary', 'binary'], ['二进制', 'binary'],
]);

export function extOf(rel) {
  const base = String(rel).split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

export function classifyExt(ext) {
  return KIND_BY_EXT.get(String(ext).toLowerCase()) ?? 'other';
}

/**
 * 无扩展名文件的判类：`LICENSE`、`README`、`Dockerfile` 这些没有后缀，光看扩展名
 * 会全掉进 other，而 other 在整机索引里是最大的一桶——不修这一条，结果页全是噪音。
 */
const NAME_KIND = new Map(
  Object.entries({
    readme: 'text',
    license: 'text',
    licence: 'text',
    changelog: 'text',
    notice: 'text',
    authors: 'text',
    makefile: 'code',
    dockerfile: 'code',
    vagrantfile: 'code',
    procfile: 'code',
    gemfile: 'code',
    rakefile: 'code',
    cmakelists: 'code',
    '.gitignore': 'text',
    '.gitattributes': 'text',
    '.editorconfig': 'text',
    '.npmrc': 'text',
    '.env': 'text',
  }),
);

/** 只有扩展名、不看内容——所以「.txt 里装的是代码」会被归成 text，这是已知且写进文档的局限。 */
export function classifyPath(rel) {
  const ext = extOf(rel);
  const kind = ext ? classifyExt(ext) : 'other';
  if (kind !== 'other') return { ext, kind };
  const base = String(rel).split('/').pop() ?? '';
  const stem = (ext ? base.slice(0, -(ext.length + 1)) : base).toLowerCase();
  return { ext, kind: NAME_KIND.get(stem) ?? NAME_KIND.get(base.toLowerCase()) ?? 'other' };
}

export function isDepDir(name) {
  return DEP_DIRS.has(String(name).toLowerCase());
}

export function isSystemDir(name) {
  return SYSTEM_DIRS.has(String(name).toLowerCase());
}

export function isCacheDir(name) {
  return CACHE_DIRS.has(String(name).toLowerCase());
}

export function isSkipFile(name) {
  return SKIP_FILES.has(String(name).toLowerCase());
}

/**
 * 一个目录该不该进。返回 null=可以进，否则返回跳过原因（好让 summary 能解释「为什么少了」）。
 */
export function skipReason(name, { includeDeps = false, includeSystem = false, parentName = '' } = {}) {
  const low = String(name).toLowerCase();
  if (!includeSystem && isSystemDir(low)) return 'system';
  if (!includeDeps && isDepDir(low)) return 'dependency';
  if (!includeDeps && isCacheDir(low)) return 'cache';
  // AppData 下的 Local/Temp 之类：CACHE_DIRS 已经覆盖 temp/cache 本身，这里是 Package Cache
  if (low === 'package cache') return 'cache';
  if (parentName && String(parentName).toLowerCase() === 'programdata' && low === 'package cache') return 'cache';
  return null;
}

/** 把查询里的 kind/ext 说法归一。`图片` / `png,jpg` / `image` 都要能用。 */
export function normalizeFilters({ kind, ext } = {}) {
  const kinds = new Set();
  const exts = new Set();
  // kind 与 ext 要分开处理：`pdf` 既是一个类型也是一个扩展名，
  // 混在一个 push 里会让 `ext=pdf` 变成按类型筛（实测筛不出东西）。
  const pieces = (raw) => String(raw).split(/[,;\s]+/).filter(Boolean);
  for (const piece of kind ? pieces(kind) : []) {
    const low = piece.toLowerCase();
    kinds.add(KIND_ALIASES.get(low) ?? low);
  }
  for (const piece of ext ? pieces(ext) : []) {
    const low = piece.toLowerCase().replace(/^\./, '');
    if (low) exts.add(low);
  }
  return { kinds, exts };
}

/**
 * 查询匹配。q 支持多词（空格分隔）且要求全部命中，匹配对象是完整路径——
 * 因为「在哪个目录下」往往比文件名更能定位。
 */
export function matchEntry(entry, { q = '', kinds = new Set(), exts = new Set(), since = 0, minBytes = 0 }) {
  if (minBytes && entry.s < minBytes) return false;
  if (since && entry.m < since) return false;
  if (exts.size && !exts.has(entry.e)) return false;
  if (kinds.size && !kinds.has(entry.k)) return false;
  const terms = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const hay = entry.p.toLowerCase();
    for (const t of terms) if (!hay.includes(t)) return false;
  }
  return true;
}

/** 结果排序：先近期、再小体积靠前（越可能是「能打开看看」的），最后按路径稳定排序。 */
export function sortHits(list) {
  return list.sort((a, b) => b.m - a.m || a.s - b.s || a.p.localeCompare(b.p));
}

export function summarizeIndex(entries, manifest = {}) {
  const byKind = {};
  let bytes = 0;
  for (const e of entries) {
    byKind[e.k] = (byKind[e.k] ?? 0) + 1;
    bytes += e.s || 0;
  }
  return {
    files: entries.length,
    bytes,
    byKind,
    roots: manifest.roots ?? [],
    scannedAt: manifest.scannedAt ?? '',
    truncated: !!manifest.truncated,
    skipped: manifest.skipped ?? {},
    durationMs: manifest.durationMs ?? 0,
    incremental: manifest.incremental ?? null,
  };
}

export function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ 渲染 */

export function renderProbeCap(sum, { probeLevel = 'fast' } = {}) {
  const lines = [`**能力探测 · ${probeLevel}**  ${sum.probedAt}`, ''];
  const host = sum.host ?? {};
  if (host.hostname || host.platform) {
    lines.push(
      `${host.hostname ?? '本机'} · ${host.platform ?? ''} ${host.arch ?? ''} · ${host.cpus ?? '?'} 核 · ${host.memGB ? host.memGB + ' GB' : '?'} 内存`,
      '',
    );
  }
  if (sum.runtimes.length) {
    lines.push('| 运行时 | 版本 |', '| --- | --- |');
    for (const r of sum.runtimes) lines.push(`| ${r.label} | ${r.version || '—'} |`);
    lines.push('');
  }
  if (sum.tools.length) {
    lines.push(`工具：${sum.tools.map((t) => `${t.label} ${t.version || ''}`.trim()).join(' · ')}`, '');
  }
  if (sum.hardware.length) {
    for (const h of sum.hardware) lines.push(`硬件 ${h.label}：${(h.lines || []).join('; ') || '—'}`);
    lines.push('');
  }
  if (sum.packages.length) {
    lines.push('| 包来源 | 数量 |', '| --- | --- |');
    for (const p of sum.packages) lines.push(`| ${p.source} | ${p.count} |`);
    lines.push('');
  }
  if (sum.condaEnvs.length) {
    lines.push(`Conda 环境（${sum.condaEnvs.length}）：${sum.condaEnvs.map((e) => '`' + e + '`').join('、')}`, '');
  }
  if (sum.missing.length) {
    lines.push(`未探到（不算错，只是这台机器没有）：${sum.missing.map((m) => m.label).join('、')}`, '');
  }
  return lines.join('\n');
}

export function renderFind(hits, { q, total, shown }) {
  if (!hits.length) return `**检索** \`${q}\` → 没有命中。换个词，或先 \`action=scan\` 建索引。`;
  const lines = [
    `**检索** \`${q}\` → 命中 ${total} 个${total > shown ? `，显示前 ${shown}` : ''}`,
    '',
    '| 文件 | 类型 | 大小 | 修改时间 |',
    '| --- | --- | --- | --- |',
  ];
  for (const h of hits) {
    const when = h.m ? new Date(h.m).toISOString().slice(0, 10) : '';
    lines.push(`| \`${h.p}\` | ${h.k} | ${humanBytes(h.s)} | ${when} |`);
  }
  return lines.join('\n');
}

export function renderIndexStats(sum, capabilities) {
  const lines = ['**索引现状**', ''];
  if (!sum.files) {
    lines.push('还没有建过文件索引。先 `action=scan`。');
  } else {
    lines.push(
      `共 ${sum.files} 个文件、${humanBytes(sum.bytes)}；根：${sum.roots.map((r) => '`' + r + '`').join('、') || '—'}`,
      `扫描于 ${sum.scannedAt}（耗时 ${Math.round((sum.durationMs || 0) / 1000)}s）${sum.truncated ? '，**已达上限、未扫全**' : ''}`,
    );
    const kinds = Object.entries(sum.byKind).sort((a, b) => b[1] - a[1]);
    if (kinds.length) {
      lines.push('', '| 类型 | 数量 |', '| --- | --- |');
      for (const [k, n] of kinds) lines.push(`| ${k} | ${n} |`);
    }
    const skip = Object.entries(sum.skipped ?? {}).filter(([, n]) => n > 0);
    if (skip.length) {
      lines.push('', `跳过的目录（计数）：${skip.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
      lines.push('依赖目录的版本信息在能力层已有；要连它们一起扫，加 `includeDeps=true`。');
    }
    if (sum.incremental) {
      const d = sum.incremental;
      lines.push('', `增量：新增 ${d.added} · 修改 ${d.changed} · 删除 ${d.removed} · 未变 ${d.unchanged}`);
    }
  }
  if (capabilities?.items?.length) {
    lines.push('', `能力层：${summarizeIndex([]).files === 0 ? '' : ''}${capabilities.items.filter((i) => i.ok).length} 项探测成功、${capabilities.items.filter((i) => !i.ok).length} 项未探到。`);
  }
  return lines.join('\n');
}
/* ------------------------------------------------------------------ 分批合并 */

// 盘符大小写、正反斜杠都要先统一，否则「已经扫过的盘」会被判成「不在范围内」。
export function normPath(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

export function boundsOf(roots) {
  const out = [];
  for (const r of roots) {
    const n = normPath(r);
    out.push(n.endsWith('/') ? n : `${n}/`);
  }
  return out;
}

export function insideAny(bounds) {
  return (p) => {
    const n = normPath(p);
    return bounds.some((b) => n.startsWith(b) || `${n}/` === b);
  };
}

/**
 * 合并两轮的「目录 mtime 表」。
 *
 * 这张表决定下一轮能复用哪些子树，所以它只能增，不能因为「本轮没走到」就被丢：
 * 非 force 时没走到的目录是被整棵子树复用的（walkDeep 只记当前这一层，不会把子树里的
 * 目录再记一遍），丢弃它们会让表每扫一次薄一层，最后整盘塌成空壳——实测 E 盘 46972 条
 * 被塌成 217 条、删除 46755。
 *
 * force 表示「这一轮把范围内全量重走」，才会把范围内的旧值清掉；但那一轮若被截断，
 * 重走并不完整，仍然保留旧值。
 */
export function mergeDirs(prevDirs, nextDirs, { roots, force = false, truncated = false } = {}) {
  const inside = insideAny(boundsOf(roots ?? []));
  const out = {};
  for (const [k, v] of Object.entries(prevDirs ?? {})) {
    if (!force || truncated || !inside(k)) out[k] = v;
  }
  return Object.assign(out, nextDirs ?? {});
}
