/**
 * 业务清单校验器（B1）
 * 在解压阶段对照 ARCHIVE_MANIFEST 固定文件清单逐一比对解压条目：
 * - 命中清单（nameRules/suffixRules/prefixRules）→ 放行并标记类型
 * - 未命中 → 标记为 unsupported，预览区由 UnsupportedPlaceholder 展示「不支持解压展示」
 */
import { resolveTypeByManifest, UNSUPPORTED_TYPE } from '@/config/archive-manifest'
import type { FileEntry } from '@/types'

/** 单个条目的清单比对结果 */
export interface ManifestEntryResult {
  /** 文件条目 */
  entry: FileEntry
  /** 识别出的业务类型（未命中时为 UNSUPPORTED_TYPE） */
  type: string
}

/** 清单校验汇总结果 */
export interface ManifestCheckResult {
  /** 命中清单的条目（含识别类型） */
  supported: ManifestEntryResult[]
  /** 清单外的未知条目（预览时显示「不支持解压展示」） */
  unsupported: ManifestEntryResult[]
}

/**
 * 业务清单校验器
 * 复用 archive-manifest.ts 的 resolveTypeByManifest 纯函数，与运行时调度器（FileDispatcher）判定一致
 */
export class ManifestValidator {
  /**
   * 判断单个文件名是否命中业务清单
   * @param fileName - 文件名
   * @returns 是否为清单内支持的类型
   */
  isSupported(fileName: string): boolean {
    return resolveTypeByManifest(fileName) !== UNSUPPORTED_TYPE
  }

  /**
   * 对解压条目列表逐一比对业务清单（目录条目直接放行，不参与类型判定）
   * @param entries - 解压后的文件条目列表
   * @returns 支持/不支持两组比对结果
   */
  check(entries: FileEntry[]): ManifestCheckResult {
    const supported: ManifestEntryResult[] = []
    const unsupported: ManifestEntryResult[] = []
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const type = resolveTypeByManifest(entry.name)
      if (type === UNSUPPORTED_TYPE) {
        unsupported.push({ entry, type })
      } else {
        supported.push({ entry, type })
      }
    }
    return { supported, unsupported }
  }
}

/** 清单校验器共享单例（无内部状态，可安全复用） */
export const manifestValidator = new ManifestValidator()
