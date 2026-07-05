/**
 * 文件验证模块
 * 采用策略链模式，每个检查器实现 FileValidator 接口，可灵活扩展。
 */

/** 单个验证结果 */
export interface ValidationResult {
  /** 是否通过 */
  ok: boolean
  /** 失败时的提示信息 */
  message?: string
}

/** 验证器接口 —— 新增检查规则只需实现此接口 */
export interface FileValidator {
  /** 验证器名称（用于日志/调试） */
  name: string
  /** 执行验证，返回 Promise 以支持异步检查（如读取文件内容） */
  validate(file: File): Promise<ValidationResult>
}

// ─── 内置验证器 ────────────────────────────────────────────

/** 检查文件扩展名是否为 .zip */
export class ZipExtensionValidator implements FileValidator {
  name = 'ZipExtension'

  async validate(file: File): Promise<ValidationResult> {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (ext !== '.zip') {
      return { ok: false, message: `不支持的文件格式「${ext}」，当前仅支持 .zip` }
    }
    return { ok: true }
  }
}

/**
 * 检查 ZIP 内是否包含 VERSION.txt 文件。
 * 使用 fflate 的 unzipSync 解压并获取文件名列表。
 * 注意：unzipSync 会解压所有内容到内存，对于大型 ZIP 文件可能占用较多内存。
 * 如需优化，可改用仅读取 ZIP 中央目录（Central Directory）的方案。
 */
export class ZipContentValidator implements FileValidator {
  /** 必须存在的文件路径（支持精确匹配或后缀匹配） */
  private readonly requiredFiles: string[]

  constructor(requiredFiles: string[] = ['VERSION.txt']) {
    this.requiredFiles = requiredFiles
  }

  name = 'ZipContent'

  async validate(file: File): Promise<ValidationResult> {
    try {
      const data = new Uint8Array(await file.arrayBuffer())

      // 优先使用 fflate 的 unzipSync 获取文件名列表
      if (__PLATFORM__ === 'web' || __PLATFORM__ === 'tauri') {
        const { unzipSync } = await import('fflate')
        const unzipped = unzipSync(data)
        const entryNames = Object.keys(unzipped).map(n => n.replace(/\/$/, ''))

        const missing = this.requiredFiles.filter(
          required => !entryNames.some(entry => entry === required || entry.endsWith('/' + required)),
        )

        if (missing.length > 0) {
          return {
            ok: false,
            message: `压缩包中缺少必要文件：${missing.join(', ')}`,
          }
        }
        return { ok: true }
      }

      // 兜底：无法解析时视为通过（交给后续解压流程处理）
      return { ok: true }
    } catch {
      return { ok: false, message: '无法读取压缩包内容，文件可能已损坏' }
    }
  }
}

// ─── 验证管线 ──────────────────────────────────────────────

/**
 * 验证管线：按顺序执行所有验证器，遇到第一个失败即短路返回。
 * 后续新增检查只需在 defaultValidators 中追加实例即可。
 */
export class ValidationPipeline {
  private readonly validators: FileValidator[]

  constructor(validators: FileValidator[]) {
    this.validators = validators
  }

  async validate(file: File): Promise<ValidationResult> {
    for (const validator of this.validators) {
      const result = await validator.validate(file)
      if (!result.ok) {
        return result
      }
    }
    return { ok: true }
  }

  /** 批量验证多个文件，返回每个文件的验证结果 */
  async validateAll(files: File[]): Promise<Map<File, ValidationResult>> {
    const results = new Map<File, ValidationResult>()
    for (const file of files) {
      const result = await this.validate(file)
      results.set(file, result)
      if (!result.ok) break // 第一个失败即停止
    }
    return results
  }
}

// ─── 默认管线 ──────────────────────────────────────────────

/** 默认验证器列表 —— 扩展新规则在此追加 */
const defaultValidators: FileValidator[] = [
  new ZipExtensionValidator(),
  new ZipContentValidator(),
]

/** 创建默认验证管线（单例） */
let _pipeline: ValidationPipeline | null = null

export function getFileValidator(): ValidationPipeline {
  if (!_pipeline) {
    _pipeline = new ValidationPipeline(defaultValidators)
  }
  return _pipeline
}

/** 重置管线（测试用） */
export function resetFileValidator(): void {
  _pipeline = null
}
