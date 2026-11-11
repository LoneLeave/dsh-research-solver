/**
 * 落盘层：唯一允许碰文件系统的地方。
 *
 * 两条纪律：
 *  1. 状态文件是真相源，human/ 全部由它渲染生成，不允许反向同步；
 *  2. 每次写入都记日志，事后能回答「这条数据是谁、什么时候写进来的」。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyze } from './engine.mjs';
import { renderAll } from './render.mjs';

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
