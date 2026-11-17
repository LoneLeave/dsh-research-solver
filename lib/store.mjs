/**
 * 落盘层：唯一允许碰文件系统的地方。
 *
 * 两条纪律：
 *  1. 状态文件是真相源，human/ 全部由它渲染生成，不允许反向同步；
 *  2. 每次写入都记日志，事后能回答「这条数据是谁、什么时候写进来的」。
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyze } from './engine.mjs';
import { renderAll } from './render.mjs';
import * as indexer from './indexer.mjs';

export const PROJECT_ROOT = 'research';
export const STATE_REL = 'ai/state.json';
export const INDEX_REL = 'ai/index.json';
export const SOURCES_REL = 'ai/evidence/sources.jsonl';
export const LOG_REL = 'ai/log.jsonl';

export function projectDir(workspace, slug) {
  return path.join(workspace, PROJECT_ROOT, slug);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function readText(file) {
  return fs.readFile(file, 'utf8');
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readState(dir) {
  const raw = await readText(path.join(dir, STATE_REL));
  return JSON.parse(raw);
}

/** 落盘：渲染 human/ → 写 state → 写 sources.jsonl → 写 index.json。 */
export async function saveProject(dir, state) {
  const analysis = analyze(state);
  const files = renderAll(state, analysis);
  const hashes = {};

  for (const [rel, content] of Object.entries(files)) {
    await writeText(path.join(dir, rel), content);
    hashes[rel] = sha256(content);
  }

  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  await writeText(path.join(dir, STATE_REL), stateText);

  const sourcesText = state.sources.map((s) => JSON.stringify(s)).join('\n');
  await writeText(path.join(dir, SOURCES_REL), sourcesText ? `${sourcesText}\n` : '');

  const index = {
    version: 1,
    generatedAt: state.updatedAt,
    slug: state.slug,
    title: state.title,
    stage: analysis.stage,
    metricsVersion: state.metricsVersion,
    rounds: state.rounds.length,
    stateHash: sha256(stateText),
    files: hashes,
  };
  await writeText(path.join(dir, INDEX_REL), `${JSON.stringify(index, null, 2)}\n`);

  return { analysis, index, files: Object.keys(files) };
}

/** 追加一行审计日志。失败不阻断主流程——日志不该成为单点故障。 */
export async function appendLog(dir, entry) {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    await fs.mkdir(path.dirname(path.join(dir, LOG_REL)), { recursive: true });
    await fs.appendFile(path.join(dir, LOG_REL), line, 'utf8');
  } catch {
    /* 忽略：日志可缺失，状态不可缺失 */
  }
}

/** 体检：重新渲染一遍，与磁盘上的文件逐字节比较。 */
export async function checkIntegrity(dir, state) {
  const analysis = analyze(state);
  const expected = renderAll(state, analysis);
  const issues = [];

  for (const [rel, content] of Object.entries(expected)) {
    let actual = null;
    try {
      actual = await readText(path.join(dir, rel));
    } catch {
      actual = null;
    }
    if (actual === null) {
      issues.push({ code: 'H001', level: 'error', message: `缺少文件 ${rel}` });
    } else if (actual !== content) {
      issues.push({ code: 'H002', level: 'warn', message: `${rel} 与状态不一致（被手改过，或写入未完成）` });
    }
  }

  // 状态文件本身是否仍能被解析、版本是否匹配
  const stateFile = path.join(dir, STATE_REL);
  if (await exists(stateFile)) {
    const text = await readText(stateFile);
    if (text !== `${JSON.stringify(state, null, 2)}\n`) {
      issues.push({ code: 'H003', level: 'warn', message: 'ai/state.json 与内存状态不一致' });
    }
  }

  return { analysis, issues };
}

/* ------------------------------------------------------- 文件治理（file_layout） */

/** 不该被当成「内容文件」对待的目录：依赖、版本库、缓存。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  'dist',
  'build',
  '.idea',
  '.dsh',
]);

export async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 建目录（含父级）；已存在不报错。 */
export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/**
 * 走一遍目录，返回内容文件的相对路径与字节数。
 * 跳过依赖与缓存目录、跳过隐藏文件；超过上限就停，并在结果里说明被截断。
 */
export async function walkFiles(root, { maxDepth = 8, maxFiles = 2000 } = {}) {
  const out = [];
  let truncated = false;

  async function walk(abs, rel, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(childAbs, childRel, depth + 1);
      } else if (e.isFile()) {
        let bytes = 0;
        try {
          bytes = (await fs.stat(childAbs)).size;
        } catch {
          bytes = 0;
        }
        out.push({ rel: childRel, bytes });
      }
    }
  }

  await walk(root, '', 0);
  return { files: out, truncated };
}

/**
 * 按 {相对路径: 内容} 写文件。
 * overwrite=false 时只补缺失的，不动已有内容——init 拿到一个已有目录时必须是这个语义。
 */
export async function writeFiles(root, map, { overwrite = true } = {}) {
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(map)) {
    const abs = path.join(root, rel);
    if (!overwrite && (await exists(abs))) {
      skipped.push(rel);
      continue;
    }
    await writeText(abs, content);
    written.push(rel);
  }
  return { written, skipped };
}

/**
 * 把根目录下的一个文件挪进目标格子。目标同名文件存在时默认失败，绝不覆盖别人的东西。
 */
export async function moveInto(root, rel, folder, { force = false } = {}) {
  const from = path.join(root, rel);
  if (!(await exists(from))) throw new Error(`文件不存在：${rel}`);
  const stat = await fs.stat(from);
  if (!stat.isFile()) throw new Error(`不是普通文件：${rel}`);

  const dest = path.join(root, folder, path.basename(rel));
  if ((await exists(dest)) && !force) {
    throw new Error(`目标已存在：${folder}/${path.basename(rel)}（确认无冲突后加 force=true 覆盖）`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });

  try {
    await fs.rename(from, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fs.copyFile(from, dest);
      await fs.unlink(from);
    } else {
      throw err;
    }
  }
  return { from: rel, to: path.posix.join(folder, path.basename(rel)) };
}

/** 列出工作区里已有的所有研究项目。 */
export async function listProjects(workspace) {
  const root = path.join(workspace, PROJECT_ROOT);
  let names = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const file = path.join(root, name, STATE_REL);
    try {
      const st = JSON.parse(await readText(file));
      out.push({ slug: st.slug ?? name, title: st.title ?? name, updatedAt: st.updatedAt ?? '' });
    } catch {
      /* 跳过损坏或不完整的目录 */
    }
  }
  return out;
}

/* ============================================================ 系统资源索引
 *
 * 这套索引不属于某个研究项目，而是属于这台机器。它存在一个独立的 store 目录里，
 * 默认是 <工作区>/research/_index，可以整个删掉重扫，不影响任何研究项目的状态。
 *
 * 为什么默认放在工作区而不是用户主目录：索引是给人和 AI 一起看的产物，
 * 放在看得见、能随手 `rm -rf` 的地方，比藏进 AppData 更符合「用户拥有自己的数据」。
 */

export const SYSTEM_STORE = '_index';
export const CAP_REL = 'capabilities.json';
export const MANIFEST_REL = 'manifest.json';
export const FILES_REL = 'files.jsonl';
// 目录 mtime 单独存一行一行的 JSONL：塞进 manifest.json 会把它涨到几百 MB，
// 下次读 manifest 时 JSON.parse 直接爆掉（实测 394 MB / 160 万条目就失败了）。
export const DIRS_REL = 'dirs.jsonl';

export function systemStoreDir(workspace) {
  return path.join(workspace, PROJECT_ROOT, SYSTEM_STORE);
}

/**
 * 解码子进程输出。Windows 中文系统的 cmd 用 GBK，按 UTF-8 硬解会变乱码，
 * 而乱码会让「命令不存在」和「命令有输出」分不清。所以先严格按 UTF-8 解，
 * 解不动才退回 GBK（Node 自带的 TextDecoder 基于 ICU，认 gbk）。
 */
function decodeOutput(buffers) {
  if (!buffers || !buffers.length) return '';
  const all = Buffer.concat(buffers);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    try {
      return new TextDecoder('gbk').decode(all);
    } catch {
      return all.toString('utf8');
    }
  }
}

/** 一行摘要，给 why 用。 */
function firstLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return line ? line.slice(0, 140) : '';
}

/**
 * 跑一个命令并收结果。永不抛：超时、找不到、非零退出都变成结构化失败。
 *
 * Windows 上 npm/pnpm/conda 之类是 .cmd/.bat 包装脚本，直接 spawn 会 ENOENT，
 * 所以必须经 shell。命令与参数全部来自 probe.mjs 里的静态声明表（没有用户输入），
 * 不存在注入面；含空格的参数单独加引号，否则 shell 会把 `-e console.log(x)` 拆成两段。
 *
 * 成功判据很关键：非零退出且只有 stderr 的，一律算「没探到」。那正是
 * 「'go' 不是内部或外部命令」和 Microsoft Store 占位符 python3 的样子；
 * 把它们当成功，会让人以为机器上装了根本不存在的工具。
 * 反过来 java -version 是「走 stderr 但退出码 0」，那仍然算成功。
 */
export function runProbeCommand(cmd, args = [], { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const quote = (a) => {
      const s = String(a);
      return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
    };
    const line = [cmd, ...args].map(quote).join(' ');
    let done = false;
    let outBufs = [];
    let errBufs = [];
    let outBytes = 0;
    let errBytes = 0;
    const MAX_OUT = 4_000_000;
    const snapshot = () => ({ stdout: decodeOutput(outBufs), stderr: decodeOutput(errBufs) });
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve({ ...snapshot(), ...payload, ms: payload.ms ?? Date.now() - started });
    };
    let child;
    try {
      child = spawn(line, { shell: true, windowsHide: true, env: process.env });
    } catch (e) {
      finish({ ok: false, why: `无法启动：${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, why: `超时（${timeoutMs}ms）`, ms: timeoutMs });
    }, Math.max(500, timeoutMs));
    child.stdout?.on('data', (b) => {
      if (outBytes < MAX_OUT) {
        outBufs.push(b);
        outBytes += b.length;
      }
    });
    child.stderr?.on('data', (b) => {
      if (errBytes < MAX_OUT) {
        errBufs.push(b);
        errBytes += b.length;
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, why: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const { stdout, stderr } = snapshot();
      if (code === 0) {
        if (stdout.trim() || stderr.trim()) finish({ ok: true, code });
        else finish({ ok: false, code, why: '退出码 0 但没有输出' });
      } else if (stdout.trim()) {
        // 有 stdout 说明命令确实跑起来了，只是返回非零（有些工具的版本探测如此）
        finish({ ok: true, code });
      } else {
        // 非零退出且只有 stderr：这正是「不是内部或外部命令」和 Store 占位符的样子。
        // 算成功的话，会让人以为机器上装了根本不存在的工具——那比少报更糟。
        finish({ ok: false, code, why: firstLine(stderr) || `退出码 ${code}` });
      }
    });
  });
}

/** 探测能力层。level=fast 只跑版本号类，level=full 才去列包（那一步慢）。 */
export async function probeAll(probes, { level = 'fast', concurrency = 6 } = {}) {
  const wanted = probes.filter((p) => (level === 'full' ? true : p.tier === 'fast'));
  const results = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= wanted.length) return;
      const p = wanted[i];
      const run = await runProbeCommand(p.cmd, p.args, { timeoutMs: p.tier === 'heavy' ? 30000 : 5000 });
      results[i] = { probe: p, run };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  return results;
}

/**
 * 深度遍历，并为「目录 mtime 未变 → 整棵子树未变」做短路。
 *
 * 增量靠的是一个可靠的事实：子目录内容增删会更新父目录的 mtime。所以只要某目录
 * mtime 和上次记的一样，就能直接复用上次那份清单，不必进去 readdir/stat 每个文件。
 * 第二次扫描一个几十万文件的盘因此从分钟级降到秒级。
 */
export async function walkDeep(root, {
  maxDepth = 24,
  maxFiles = 200000,
  budgetMs = 0,
  includeDeps = false,
  includeSystem = false,
  prev = null,
  signal = null,
  onProgress = null,
} = {}) {
  const { skipReason, isSkipFile, classifyPath } = indexer;
  const entries = [];
  const dirs = {};
  const skipped = {};
  let truncated = false;
  let visitedDirs = 0;
  let reusedDirs = 0;
  const started = Date.now();
  // 索引里一律存绝对路径（正斜杠），因为索引可能横跨多个盘，相对路径会有歧义。
  const prefix = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const absOf = (rel) => (rel ? `${prefix}/${rel}` : prefix);

  const queue = [{ rel: '', abs: root, depth: 0 }];
  while (queue.length) {
    if (signal?.aborted) break;
    if (entries.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (budgetMs && Date.now() - started > budgetMs) {
      truncated = true;
      break;
    }
    const cur = queue.shift();
    let dirents;
    try {
      dirents = await fs.readdir(cur.abs, { withFileTypes: true });
    } catch {
      skipped['unreadable'] = (skipped['unreadable'] ?? 0) + 1;
      continue;
    }
    visitedDirs += 1;
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maxFiles) {
        truncated = true;
        break;
      }
      const childRel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      const childAbs = path.join(cur.abs, d.name);
      if (d.isDirectory()) {
        if (d.name.startsWith('.') && d.name !== '.') {
          // 隐藏目录默认跳过，但记数——用户要「全部」，就必须能看见跳了什么
          skipped['hidden'] = (skipped['hidden'] ?? 0) + 1;
          continue;
        }
        const why = skipReason(d.name, { includeDeps, includeSystem, parentName: path.basename(cur.abs) });
        if (why) {
          skipped[why] = (skipped[why] ?? 0) + 1;
          continue;
        }
        if (cur.depth + 1 > maxDepth) {
          skipped['depth'] = (skipped['depth'] ?? 0) + 1;
          continue;
        }
        let mtimeMs = 0;
        try {
          mtimeMs = (await fs.stat(childAbs)).mtimeMs;
        } catch {
          skipped['unreadable'] = (skipped['unreadable'] ?? 0) + 1;
          continue;
        }
        const key = absOf(childRel);
        dirs[key] = mtimeMs;
        // 复用单元必须是「整棵子树」而不是「这一层的文件」：目录 mtime 没变，
        // 说明它下面的一切都没变，可以直接把该子树在上一份索引里的全部条目搬过来。
        // 上一版按「直属文件」分组去复用，于是每复用一个目录就丢掉了它所有的孙子，
        // 整盘被当成已删除（实测 E 盘 46972 条塌成 217 条）。
        // 复用只在 prev 完整时用（调用方保证 truncated 轮不传 prev）。
        if (prev && prev.dirs && prev.dirs[key] === mtimeMs && typeof prev.subtree === 'function') {
          const sub = prev.subtree(key);
          for (const e of sub) {
            if (entries.length >= maxFiles) {
              truncated = true;
              break;
            }
            entries.push(e);
          }
          reusedDirs += 1;
          if (truncated) break;
          continue;
        }
        queue.push({ rel: childRel, abs: childAbs, depth: cur.depth + 1 });
      } else if (d.isFile()) {
        if (isSkipFile(d.name)) {
          skipped['junk'] = (skipped['junk'] ?? 0) + 1;
          continue;
        }
        let st;
        try {
          st = await fs.stat(childAbs);
        } catch {
          skipped['unreadable'] = (skipped['unreadable'] ?? 0) + 1;
          continue;
        }
        const { ext, kind } = classifyPath(childRel);
        entries.push({ p: absOf(childRel), s: st.size, m: Math.round(st.mtimeMs), e: ext, k: kind });
      }
    }
    if (onProgress && visitedDirs % 500 === 0) onProgress({ visitedDirs, files: entries.length, elapsedMs: Date.now() - started });
    // 让出事件循环，避免长时间扫描饿死其它请求
    if (visitedDirs % 64 === 0) await new Promise((r) => setImmediate(r));
  }

  return { entries, dirs, skipped, truncated, visitedDirs, reusedDirs, durationMs: Date.now() - started };
}

/* ------------------------------------------------------------------ 索引落盘 */

async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function readCapabilities(store) {
  try {
    const st = JSON.parse(await readText(path.join(store, CAP_REL)));
    if (st && Array.isArray(st.items)) return st;
  } catch {
    /* 还没探过 */
  }
  return null;
}

export async function writeCapabilities(store, capabilities) {
  await writeJsonAtomic(path.join(store, CAP_REL), capabilities);
}

/** 索引主体用 JSONL：一行一条，追加友好、体积小、坏一行不会毁掉整个文件。 */
/** 已解析索引的进程内缓存。百万条级别重读要好几秒，而索引只在写盘后变。 */
const INDEX_CACHE = new Map();

export async function readFileIndex(store) {
  const filesPath = path.join(store, FILES_REL);
  let stamp = '';
  try {
    const st = await fs.stat(filesPath);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { entries: [], manifest: null }; // 还没扫过
  }
  const hit = INDEX_CACHE.get(store);
  if (hit && hit.stamp === stamp) return hit.value;

  const out = { entries: [], manifest: null };
  try {
    const raw = await readText(filesPath);
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e && typeof e.p === 'string') out.entries.push(e);
      } catch {
        /* 坏行跳过，不让一行垃圾废掉整个索引 */
      }
    }
  } catch {
    /* ignore */
  }
  // 子树索引：条目按路径排序后，某目录的整棵子树就是一段连续区间，二分即可取出。
  // 这样既不必把「目录 → 子树条目」那张表常驻内存（160 万条时会涨到几百 MB，甚至
  // 把 manifest.json 撑到 394 MB 让 JSON.parse 直接失败），又能按子树整体复用。
  const cmpPath = (a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  let sorted = true;
  for (let i = 1; i < out.entries.length; i++) {
    if (out.entries[i - 1].p > out.entries[i].p) {
      sorted = false;
      break;
    }
  }
  if (!sorted) out.entries.sort(cmpPath);
  const lowerBound = (target) => {
    let lo = 0;
    let hi = out.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (out.entries[mid].p < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const subtree = (dir) => {
    const base = String(dir).replace(/\/+$/, '');
    const start = lowerBound(`${base}/`);
    // '0' 是 '/' 后面的下一个字符，所以 base+'0' 恰好是这段连续区间的上界
    const end = lowerBound(`${base}0`);
    return out.entries.slice(start, end);
  };

  const dirs = Object.create(null);
  try {
    const raw = await readText(path.join(store, DIRS_REL));
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const d = JSON.parse(t);
        if (d && typeof d.d === 'string') dirs[d.d] = d.m;
      } catch {
        /* 同上，坏行跳过 */
      }
    }
  } catch {
    /* 旧版本没有这个文件 */
  }

  try {
    const m = JSON.parse(await readText(path.join(store, MANIFEST_REL)));
    if (m && typeof m === 'object') out.manifest = { ...m, dirs, subtree };
  } catch {
    /* ignore */
  }
  INDEX_CACHE.set(store, { stamp, value: out });
  return out;
}

export async function writeFileIndex(store, { entries, manifest, dirs }) {
  await ensureDir(store);
  // 按路径排序落盘：读回时才能用二分取「某目录的整棵子树」（增量复用依赖这个）。
  const cmpPath = (a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  let sorted = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].p > entries[i].p) {
      sorted = false;
      break;
    }
  }
  if (!sorted) entries.sort(cmpPath);
  const tmp = path.join(store, `${FILES_REL}.tmp`);
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(tmp, body ? `${body}\n` : '', 'utf8');
  await fs.rename(tmp, path.join(store, FILES_REL));

  const dtmp = path.join(store, `${DIRS_REL}.tmp`);
  const dbody = Object.entries(dirs ?? {})
    .map(([d, m]) => JSON.stringify({ d, m }))
    .join('\n');
  await fs.writeFile(dtmp, dbody ? `${dbody}\n` : '', 'utf8');
  await fs.rename(dtmp, path.join(store, DIRS_REL));

  await writeJsonAtomic(path.join(store, MANIFEST_REL), manifest ?? {});
  INDEX_CACHE.delete(store);
  return { entries: entries.length };
}

export async function clearIndex(store) {
  INDEX_CACHE.delete(store);
  for (const rel of [FILES_REL, MANIFEST_REL, DIRS_REL]) {
    try {
      await fs.unlink(path.join(store, rel));
    } catch {
      /* 不存在就算了 */
    }
  }
}

export function indexSizeOf(entries) {
  return entries.reduce((n, e) => n + (e.s || 0), 0);
}

/** 本机画像：平台、核数、内存。探测结果里带上它，「这台机器」才有具体所指。 */
export function hostInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus()?.length ?? 0,
    memGB: Math.round((os.totalmem() / 1e9) * 10) / 10,
    home: os.homedir(),
  };
}

/**
 * 有哪些盘可扫。Windows 上逐个盘符试 access（比 wmic 可靠，wmic 在新版已弃用）；
 * 别的平台就是根目录。失败即「没有」，不抛——枚举磁盘不该让整个工具挂掉。
 */
export async function discoverRoots() {
  if (process.platform === 'win32') {
    const found = [];
    for (let c = 65; c <= 90; c += 1) {
      const letter = String.fromCharCode(c);
      const p = `${letter}:\\`;
      try {
        await fs.access(p);
        found.push(p);
      } catch {
        /* 该盘符不存在或未挂载 */
      }
    }
    return found;
  }
  const roots = ['/'];
  try {
    for (const v of await fs.readdir('/Volumes')) roots.push(`/Volumes/${v}`);
  } catch {
    /* 非 macOS 或没有 /Volumes */
  }
  return roots;
}
