#!/usr/bin/env node
/**
 * Materialize one environment's reviewed D1 migration stream inside repository-local .temp.
 * 将某环境的已评审 D1 迁移流物化到仓库内 .temp，隔离环境专属客户端而不复制公共历史。
 *
 * Usage / 用法: node scripts/prepare-migrations.mjs <staging|production>
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2];
if (process.argv.length !== 3 || !['staging', 'production'].includes(target)) {
  throw new Error('usage: node scripts/prepare-migrations.mjs <staging|production>');
}

const common = 'migrations';
const overlay = join(common, 'environments', target);
const output = join('.temp', 'migration-streams', target);

/** Require the normal numbered D1 filename so its applied-history key is stable. / 确保 D1 历史键为稳定的编号文件名。 */
function migrationNames(names) {
  return names.filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
}

const commonNames = migrationNames(await readdir(common));
const overlayNames = migrationNames(await readdir(overlay));
const duplicate = overlayNames.find((name) => commonNames.includes(name));
if (duplicate) throw new Error(`migration filename collision: ${duplicate}`);
if (commonNames.length === 0) throw new Error('no common migrations found');

// A materialized stream is disposable; source files and committed D1 history are never removed.
// 物化流可重建；源文件及已提交的 D1 历史绝不删除。
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of commonNames) await copyFile(join(common, name), join(output, name));
for (const name of overlayNames) await copyFile(join(overlay, name), join(output, name));
process.stdout.write(`${output}: ${commonNames.length} common + ${overlayNames.length} ${target} migrations\n`);
