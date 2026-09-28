#!/usr/bin/env node
/**
 * Materialize one environment's reviewed D1 migration stream inside repository-local .temp.
 * 将某环境的已评审 D1 迁移流物化到仓库内 .temp，隔离环境专属客户端而不复制公共历史。
 *
 * Usage / 用法: node scripts/prepare-migrations.mjs <staging|production>
 */
import { copyFile, mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (process.argv.length !== 3 || !['staging', 'production'].includes(target)) {
  throw new Error('usage: node scripts/prepare-migrations.mjs <staging|production>');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const common = join(root, 'migrations');
const overlay = join(common, 'environments', target);
const output = join(root, '.temp', 'migration-streams', target);
const withinRoot = relative(root, output);
if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) {
  throw new Error('migration stream output escaped repository root');
}

/** Require the normal numbered D1 filename so its applied-history key is stable. / 确保 D1 历史键为稳定的编号文件名。 */
function migrationNames(names) {
  return names.filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
}

const commonNames = migrationNames(await readdir(common));
const overlayNames = migrationNames(await readdir(overlay));
const duplicate = overlayNames.find((name) => commonNames.includes(name));
if (duplicate) throw new Error(`migration filename collision: ${duplicate}`);
if (commonNames.length === 0) throw new Error('no common migrations found');

await mkdir(output, { recursive: true });
const physical = relative(await realpath(root), await realpath(output));
if (physical.startsWith('..') || isAbsolute(physical)) {
  throw new Error('migration stream output resolves outside repository root');
}
// Remove only stale numbered files in this repository-owned output, not arbitrary content.
// 仅清理仓库内物化目录中的过期编号文件，不递归删除任意内容。
for (const name of migrationNames(await readdir(output))) await unlink(join(output, name));
for (const name of commonNames) await copyFile(join(common, name), join(output, name));
for (const name of overlayNames) await copyFile(join(overlay, name), join(output, name));
process.stdout.write(`${withinRoot}: ${commonNames.length} common + ${overlayNames.length} ${target} migrations\n`);
