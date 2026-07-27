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

/**
 * 上传白名单提供器（由应用启动时注入，从插件注册表动态生成）
 * 未注入时回退到默认白名单 ['.zip']，保持 core 层与插件层解耦
 */
let uploadExtensionsProvider: (() => string[]) | null = null

/**
 * 注入上传白名单提供器（在应用入口调用，传入 registry.getUploadExtensions）
 * @param provider - 返回允许上传扩展名列表的函数
 */
export function setUploadExtensionsProvider(provider: () => string[]): void {
  uploadExtensionsProvider = provider
}

/** 检查文件扩展名是否在上传白名单内（白名单由插件注册表动态生成，默认仅 .zip） */
export class ZipExtensionValidator implements FileValidator {
  name = 'ZipExtension'

  /**
   * @param allowedExtensions - 显式指定的白名单（含前导点，小写）；缺省时使用注入的提供器或 ['.zip']
   */
  constructor(private readonly allowedExtensions?: string[]) {}

  async validate(file: File): Promise<ValidationResult> {
    const allowed = this.allowedExtensions ?? uploadExtensionsProvider?.() ?? ['.zip']
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!allowed.includes(ext)) {
      return { ok: false, message: `不支持的文件格式「${ext}」，当前仅支持 ${allowed.join(' / ')}` }
    }
    return { ok: true }
  }
}

/** 大文件阈值（200MB），超过此值跳过内容验证以避免内存溢出 */
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024

/**
 * 检查 ZIP 内是否包含 VERSION.txt 文件。
 * 使用 fflate 的 unzip + filter 仅读取条目名称列表（不解压内容），
 * 避免 unzipSync 全量解压到内存（P1 性能优化）。
 * 超过 LARGE_FILE_THRESHOLD 的文件仅验证扩展名，跳过内容解析。
 */
export class ZipContentValidator implements FileValidator {
  /** 必须存在的文件路径（支持精确匹配或后缀匹配） */
  private readonly requiredFiles: string[]

  /**
   * 创建 ZIP 内容验证器
   * @param requiredFiles - 压缩包中必须存在的文件路径列表，默认 ['VERSION.txt']
   */
  constructor(requiredFiles: string[] = ['VERSION.txt']) {
    this.requiredFiles = requiredFiles
  }

  name = 'ZipContent'

  async validate(file: File): Promise<ValidationResult> {
    try {
      // 大文件保护：超过阈值时跳过内容验证，避免内存溢出
      if (file.size > LARGE_FILE_THRESHOLD) {
        console.warn(`文件过大 (${(file.size / 1048576).toFixed(0)} MB)，跳过内容验证: ${file.name}`)
        return { ok: true }
      }

      const data = new Uint8Array(await file.arrayBuffer())

      // 使用 fflate 异步 unzip + filter 仅收集条目名，不解压任何内容
      if (__PLATFORM__ === 'web' || __PLATFORM__ === 'tauri') {
        const { unzip } = await import('fflate')
        const rawNames: string[] = []
        await new Promise<void>((resolve, reject) => {
          unzip(
            data,
            {
              // filter 在解压前被调用：记录条目名后返回 false 跳过解压
              filter: (entry) => {
                rawNames.push(entry.name)
                return false
              },
            },
            (err) => (err ? reject(err) : resolve()),
          )
        })
        const entryNames = rawNames.map(n => n.replace(/\/$/, ''))

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
    } catch (e) {
      console.warn('[Validator] ZIP 内容解析失败', e)
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

  /**
   * 创建验证管线实例
   * @param validators - 验证器数组，按顺序执行
   */
  constructor(validators: FileValidator[]) {
    this.validators = validators
  }

  /**
   * 执行验证管线，按顺序执行所有验证器，遇到第一个失败即短路返回
   * @param file - 待验证的文件
   * @returns 验证结果
   */
  async validate(file: File): Promise<ValidationResult> {
    for (const validator of this.validators) {
      const result = await validator.validate(file)
      if (!result.ok) {
        return result
      }
    }
    return { ok: true }
  }

  /**
   * 批量验证多个文件，返回每个文件的验证结果
   * @param files - 待验证的文件列表
   * @returns 文件到验证结果的映射，第一个失败后停止后续验证
   */
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

/** 默认验证管线单例引用 */
let _pipeline: ValidationPipeline | null = null

/**
 * 创建默认验证管线（单例）
 * @returns 验证管线实例
 */
export function getFileValidator(): ValidationPipeline {
  if (!_pipeline) {
    _pipeline = new ValidationPipeline(defaultValidators)
  }
  return _pipeline
}

/**
 * 重置验证管线单例（仅用于测试）
 */
export function resetFileValidator(): void {
  _pipeline = null
}
