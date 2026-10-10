// E2E 辅助：把 bootstrap.json 指向指定的隔离数据根（验收后必须恢复原文件）
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , dataDir] = process.argv
if (!dataDir) {
  console.error('usage: node scripts/e2e-bootstrap.mjs <dataDir|restore>')
  process.exit(1)
}
const appData = process.env.APPDATA
const bootstrap = join(appData, 'com.taowd.hello-tauri', 'bootstrap.json')
const backup = join(appData, 'com.taowd.hello-tauri', 'bootstrap.json.e2e-bak')

if (dataDir === 'restore') {
  if (existsSync(backup)) {
    writeFileSync(bootstrap, readFileSync(backup, 'utf8'))
    rmSync(backup)
    console.log('[e2e] bootstrap.json 已恢复原状（备份已消费）')
  } else {
    try {
      rmSync(bootstrap)
      console.log('[e2e] 无备份：已移除本次写入的 bootstrap.json（原本不存在）')
    } catch {
      console.log('[e2e] 无备份可恢复')
    }
  }
  process.exit(0)
}

// 备份只写一次（write-once）：连续切换多个数据根时，不能让后一次运行把
// 原始备份覆盖成中间态 —— 否则 restore 恢复出来的是错的。
if (!existsSync(backup)) {
  try {
    writeFileSync(backup, readFileSync(bootstrap, 'utf8'))
  } catch {
    // 原本不存在：restore 时删除即可
  }
}
writeFileSync(bootstrap, JSON.stringify({ dataDir }, null, 2))
console.log(`[e2e] bootstrap.json 已指向 ${dataDir}（原文件备份于 bootstrap.json.e2e-bak）`)
