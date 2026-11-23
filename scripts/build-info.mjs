/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 canalystii-ts contributors
 * See LICENSE and NOTICE.
 */
// 构建后写入 dist/build-info.json，供测试者在安装包里核对待测版本。
// 字段：包名、版本号、提交哈希、工作区是否有未提交改动、构建时间（UTC）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

let commit = 'unknown';
let dirty = true;
try {
  commit = git('rev-parse', '--short=12', 'HEAD');
  // dist/ 与打包产物本身不算改动，只有源码或文档变化才标记为脏。
  dirty = git('status', '--porcelain', '--', '.', ':!dist').length > 0;
} catch {
  // 没有 Git 或尚未产生提交时保留 unknown，不阻断构建。
}

const info = {
  name: pkg.name,
  version: pkg.version,
  commit,
  dirty,
  builtAt: new Date().toISOString(),
};

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
