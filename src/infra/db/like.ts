/**
 * LIKE 关键字转义（`welink.ts` / `welink-group.ts` 两个 SQL 仓储共用）。
 *
 * 用户输入原样进 `%kw%` 时，`%`/`_` 会被当作通配符：搜「100%」等于全表通配，
 * 搜工号「E_01」会命中「EA01」。统一转义并在 SQL 侧配套 `ESCAPE '\'`，让筛选框
 * 保持**字面语义**（需要通配符的场景由代码自己拼，不经用户输入）。
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
