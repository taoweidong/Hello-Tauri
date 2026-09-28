/**
 * `<el-table>` 插槽行的类型收窄（P-1 引入）
 *
 * ## 为什么需要这个函数
 *
 * Element Plus 的 `el-table` 是泛型组件 `<T extends DefaultRow = DefaultRow>`，
 * 但它的 `el-table-column` **不是**：列插槽签名被硬编码为
 * `(props: { row: DefaultRow; column: TableColumnCtx<DefaultRow>; $index: number })`。
 * 因此模板里的 `#default="{ row }"` 拿到的 `row` 永远是 `DefaultRow`
 * （即 `Record<PropertyKey, any>`），无法从 `:data` 反推真实行类型。
 *
 * 已实测无效的写法（vue-tsc 3.3.11 + element-plus 2.14.6）：
 *  * 显式 `import { ElTable } from 'element-plus'` —— 不走全局解析，仍然不推断
 *  * 插槽解构上标注 `<template #default="{ row }: { row: T }">` —— 与声明签名冲突，报 TS2345
 *
 * 换言之：**这不是某个配置漏了，而是上游类型定义的结构性限制**。
 *
 * ## 为什么收窄必须显式发生
 *
 * P-1（Element Plus 按需引入）之前，`el-table` 未在类型系统中解析，插槽参数是隐式
 * `any`，所有强类型调用静默通过；`components.d.ts` 生成后，`row` 首次有了类型
 * （虽然是宽松的 `DefaultRow`），于是这些隐式逃逸全部暴露为编译错误。
 *
 * 这是**好事**：把「一行数据到底是什么」从「无人检查」变成「必须写明」。
 * 用 `rowOf<T>()` 收窄而不是各处撒 `as`，是为了让这条上游限制只在一处被解释，
 * 组件里只留下「这一行是 T」这个业务事实。
 *
 * 若将来 Element Plus 让 `el-table-column` 也泛型化（或 vue-tsc 支持插槽泛型推断），
 * 删除本函数、把调用点改回裸 `row` 即可。
 */

/**
 * 把 `<el-table>` 插槽给出的 `DefaultRow` 收窄为业务行类型。
 *
 * 运行期是恒等函数（零开销），只承担类型系统里的收窄职责。
 *
 * @example
 * ```vue
 * <template #default="{ row }">
 *   <button @click="openEdit(rowOf<TableRow>(row))">编辑</button>
 * </template>
 * ```
 */
export function rowOf<T>(row: unknown): T {
  return row as T
}

/**
 * `<el-switch>` 的 `update:model-value` 回调值。
 *
 * el-switch 的载荷声明为 `string | number | boolean`（它同时服务开关/多选等形态），
 * 但二元开关场景实际只会给 `boolean`。用本函数把「声明签名」与「实际语义」对齐，
 * 避免在模板里写 `(value: boolean) => ...` 这种与声明不兼容的窄化标注
 * （那会报 TS2322：参数类型不兼容）。
 */
export function asBoolean(value: string | number | boolean): boolean {
  return Boolean(value)
}
