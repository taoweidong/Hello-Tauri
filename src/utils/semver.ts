/**
 * 零依赖 semver 比较（design-auto-update §11.4：不引 npm 包，项目版本恒为 x.y.z）。
 *
 * 约定：任何解析失败都返回 0（视为「无更新」）并由调用方记 warn ——
 * 更新域任何异常都不得比「不更新」更糟。
 */
export function compareSemVer(a: string, b: string): number {
  const pa = String(a ?? '')
    .trim()
    .split('.')
  const pb = String(b ?? '')
    .trim()
    .split('.')
  if (pa.length !== 3 || pb.length !== 3) return 0
  const na = pa.map(Number)
  const nb = pb.map(Number)
  if ([...na, ...nb].some((n) => !Number.isInteger(n) || n < 0)) return 0
  for (let i = 0; i < 3; i += 1) {
    if (na[i] !== nb[i]) return na[i]! > nb[i]! ? 1 : -1
  }
  return 0
}

/** 严格 semver 形态校验（x.y.z，纯数字段）—— 清单 version 字段的入口闸 */
export function isStrictSemVer(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version.trim())
}
