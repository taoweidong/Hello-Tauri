#!/usr/bin/env node
/**
 * 版本元数据单一来源（R-3 扩展）：版本号 + git 节点 + 打包时间。
 *
 * `vite.config.ts`、`vitest.config.ts`、`scripts/build.mjs` 三处共同取用，
 * 避免「界面显示的节点/打包时间」与「exe 文件名里的时间戳」各算各的出现不一致：
 *  * APP_VERSION：package.json 的 version（版本号唯一真值，R-3 不变）。
 *  * GIT_COMMIT：HEAD 前 6 位 —— 用户口径的「当前版本基于哪个节点」。git 不可用
 *    （如脱离仓库的源码分发）时降级为 ''，UI 按「未提供」处理（显示 `-`）。
 *  * BUILD_TIME：打包时间，本地时区 `YYYY-MM-DD HH:mm`。build.mjs 打包时经
 *    BUILD_TIME 环境变量传入并写进 exe 文件名；dev / 测试环境取配置加载时刻。
 *
 * 类型声明在同目录 `version-meta.d.mts`（vite.config.ts 在 tsconfig include 内，
 * 会被 vue-tsc 检查，纯 JS 模块需手工对齐类型）。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地时区 `YYYY-MM-DD HH:mm`（界面显示用；不用 toISOString —— 那是 UTC） */
export function formatBuildTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/** 紧凑时间戳 `YYYYMMDD-HHmm`（exe 文件名用 —— 文件名不能含冒号与空格） */
export function formatBuildStamp(date) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}`
  )
}

function readAppVersion() {
  return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
}

/** HEAD 前 6 位；非 git 环境静默降级为 ''（stderr 一并吞掉，不污染构建输出） */
function readGitCommit() {
  try {
    const hash = execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return hash ? hash.slice(0, 6) : ''
  } catch {
    return ''
  }
}

export const APP_VERSION = readAppVersion()
export const GIT_COMMIT = readGitCommit()
export const BUILD_TIME = process.env.BUILD_TIME || formatBuildTime(new Date())
