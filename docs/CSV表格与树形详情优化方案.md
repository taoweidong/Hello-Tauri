# CSV 表格 + 树形详情功能：业务场景符合度分析与优化方案

> 关联业务场景文档：`docs/业务场景.md`
> 分析日期：2026-07-18

---

## 一、业务场景回顾

根据 `docs/业务场景.md`，压缩包解压后的文件类型固定，关键约束如下：

| 文件 | 类型 | 展示方式 | 是否必须 |
|------|------|----------|----------|
| `VERSION.txt` | 版本说明 | 校验文件（缺失=不支持） | **必须** |
| `sample.json` | JSON 日志 | JSON 格式展示 | 否 |
| `sample.txt` | 文本日志 | 文本直接展示 | 否 |
| `sample.log` | 日志 | 拆分成表格展示 | 否 |
| `sample.csv` | CSV 日志 | **表格展示** | 否 |
| `APPLOG1-3` / `MSGLOG1-3` | 应用/消息日志 | 待定 | 否 |

**架构硬约束（原文"严格遵守"）：**
1. 一种类型的文件，对应**一个解析数据的 TS** + **一个展示数据的 Vue 页面**
2. 后续会新增其他类型文件，需**支持快速扩展**

**本次需求（用户补充）：** CSV 以表格展示，点击每一行右侧展示树形格式的隐藏数据，支持树形筛选与快速折叠。

---

## 二、当前实现符合度评估

### 2.1 架构约束符合度 ✅

CSV 类型完整遵循"一个解析 TS + 一个展示 Vue"的约束，且已实现插件化快速扩展：

| 层级 | 文件 | 职责 | 符合约束 |
|------|------|------|----------|
| 解析 TS | `src/plugins/parsers/csv-parser.ts` | CSV 文本 → `CsvData` | ✅ 独立 TS |
| 展示 Vue | `src/views/renderers/CsvRenderer.vue` | 表格 + 分栏入口 | ✅ 独立 Vue |
| 插件注册 | `src/plugins/parser/csv-plugin.ts` + `manifest.ts` | 关联解析与展示 | ✅ 零核心改动 |
| 树形派生 TS | `src/core/csv-row-tree.ts` | 单行 → 树（纯逻辑） | ✅ 独立于 Vue |
| 树形详情 Vue | `src/views/renderers/CsvTreeDetail.vue` | 树形面板 | ✅ 独立 Vue |
| 树节点 Vue | `src/views/renderers/TreeNode.vue` | 递归渲染单节点 | ✅ 独立 Vue |

新增类型只需：新建 `xxx-parser.ts` + `XxxRenderer.vue` + 在 `manifest.ts` 注册一行，满足"快速扩展"。

### 2.2 功能需求符合度

| 需求 | 状态 | 说明 |
|------|------|------|
| CSV 表格展示 | ✅ 已满足 | `DataTable.vue` 提供搜索/筛选/排序/分页/虚拟滚动/导出 |
| 点击行右侧展示树形隐藏数据 | ✅ 已满足 | `CsvRenderer` 用 `selectedIndex` 切换单栏/分栏，`SplitView` 左右可拖拽 |
| 树形数据派生 | ✅ 已满足 | `csv-row-tree.ts` 支持 JSON 列 / 路径型列 / 兜底字符串三种派生 |
| 树形搜索筛选 | ⚠️ 基本满足 | 关键字搜索 + 命中高亮 + 保留祖先路径，但无防抖 |
| 快速折叠 | ✅ 已满足 | 全部展开 / 全部折叠 / 按层级选择 三种控制 |

### 2.3 存在的缺陷与不足

| 编号 | 问题 | 严重度 | 影响 |
|------|------|--------|------|
| **D1** | 路径型叶子节点丢失 `value` | 🔴 高 | `buildPathBranch` 末段叶子无 `value`，路径型列（如 `src/components/Foo.vue`）在树中显示为空 |
| **D2** | 树形面板硬编码深色主题 | 🟡 中 | `CsvTreeDetail.vue` / `TreeNode.vue` 写死 `#1a1a2e`、`#93c5fd` 等，与项目已升级的 Tailwind 双主题（深色/浅色）冲突 |
| **D3** | 树形搜索无防抖 | 🟡 中 | 每输入一字符即触发整树递归过滤，大数据行卡顿 |
| **D4** | 搜索状态与折叠状态相互覆盖 | 🟢 低 | 搜索时强制全部展开，手动"全部折叠"会覆盖搜索展开态 |
| **D5** | 无行详情加载状态 | 🟢 低 | 选中行立即渲染，大数据行无 loading 提示 |
| **D6** | 深层/大节点树无虚拟滚动 | 🟢 低 | 节点 > 1000 或深度 > 10 时 DOM 暴增 |

**D1 代码示例（当前 bug）：**
```typescript:131:152:src/core/csv-row-tree.ts
export function buildPathBranch(header: string, segments: string[]): RowTreeNode {
  let inner: RowTreeNode = {
    key: segments[segments.length - 1],
    isLeaf: true,
    valueType: 'string',
    // ❌ 缺少 value 属性！原始单元格值丢失
  }
  // ...
}
```

---

## 三、优化方案

### 方案 1：修复路径型叶子节点 value 丢失（优先级最高，D1）

**目标：** 路径型列的末段叶子正确携带原始单元格值。

**改动点：**
1. `buildPathBranch` 增加 `cellValue` 参数，末段叶子写入 `value: cellValue`
2. `extractRowTree` 调用时传入原始 `cell`

```typescript
// csv-row-tree.ts
export function buildPathBranch(
  header: string,
  segments: string[],
  cellValue: string,   // ← 新增
): RowTreeNode {
  let inner: RowTreeNode = {
    key: segments[segments.length - 1],
    isLeaf: true,
    value: cellValue,   // ← 补充原始值
    valueType: 'string',
  }
  for (let i = segments.length - 2; i >= 0; i--) {
    inner = { key: segments[i], isLeaf: false, children: [inner] }
  }
  return { key: header, isLeaf: false, sourceColumn: header, children: [inner] }
}

// extractRowTree 中
const segments = tryParsePathCell(cell)
if (segments !== null) {
  branch = buildPathBranch(header, segments, cell)  // ← 传入 cell
}
```

**关联测试：** 补充 `csv-row-tree.test.ts` 中路径型列叶子 `value` 断言。

---

### 方案 2：树形面板适配双主题（D2）

**目标：** 跟随项目已有的 Tailwind 双主题 + `themeColor` 状态，移除硬编码颜色。

**改动点：**
- `CsvTreeDetail.vue` / `TreeNode.vue` 的 `<style scoped>` 改用项目 `src/styles/main.css` 中的 CSS 变量（如 `--color-bg-elevated`、`--color-text`、`--color-primary`），或改用 Tailwind 原子类
- 删除 `#1a1a2e` / `#93c5fd` / `#86efac` 等硬编码值，统一引用设计 Token

**参考：** `AppLayout.vue` 已迁移至 Tailwind + `@theme` 设计 Token（见 `src/styles/main.css`）。

---

### 方案 3：树形搜索防抖（D3）

**目标：** 高频输入时避免重复递归过滤。

**改动点：** `CsvTreeDetail.vue` 引入 `@vueuse/core` 的 `useDebounceFn`：

```typescript
import { useDebounceFn } from '@vueuse/core'

const rawKeyword = ref('')
const searchKeyword = ref('')
const onKeywordInput = useDebounceFn((val: string) => {
  searchKeyword.value = val
}, 200)
// NInput @update:value="onKeywordInput"
```

> 注意：当前 `searchKeyword` 直接 `v-model` 驱动 `filteredTree` computed，需拆为 `rawKeyword`（输入）→ 防抖 → `searchKeyword`（过滤）。`watch(searchKeyword)` 逻辑保持不变。

---

### 方案 4：搜索与折叠状态解耦（D4）

**目标：** 搜索展开态不被手动折叠覆盖，反之亦然。

**建议：** 引入独立 `searchActive` 标志。搜索时 `expandedDepths` 仅在 `searchActive && !userOverride` 时强制全展开；手动点击"全部折叠/展开"时设置 `userOverride = true`，清空搜索则重置。或在搜索框聚焦时暂存用户折叠态，失焦/清空时恢复。

---

### 方案 5：性能与体验增强（D5/D6，可选）

| 优化项 | 做法 |
|--------|------|
| 行详情 loading | 选中行后 `selectedTree` computed 改为 `async`/加 `loading` ref，或展示骨架屏 |
| 大节点虚拟滚动 | 顶层 `children` 超 1000 时引入虚拟列表（如 `vue-virtual-scroller`） |
| 深层嵌套限制 | 增加 `maxRenderDepth` 配置，超过后折叠渲染 |
| 节点复制 | `TreeNode` 行点击复制 key/value 到剪贴板 |
| 列宽记忆 | `DataTable` 列宽调整写入 `localStorage`，刷新保留 |

---

## 四、业务场景对照总结

| 业务场景要求 | 当前状态 | 优化后 |
|--------------|----------|--------|
| CSV 表格展示 | ✅ | ✅ |
| 点击行右侧树形隐藏数据 | ✅ | ✅（路径型列修复 value 后数据完整） |
| 树形筛选 | ✅ | ✅（加防抖更流畅） |
| 快速折叠 | ✅ | ✅（搜索/折叠解耦） |
| 一种类型 = 一 TS + 一 Vue | ✅ | ✅ |
| 快速扩展新类型 | ✅ | ✅ |
| 双主题一致性 | ❌ 硬编码深色 | ✅ 跟随时尚主题 |
| VERSION.txt 强校验 | ⚠️ 见下方说明 | 建议补强 |

**额外建议（超出 CSV 范围，供参考）：**
- `VERSION.txt` 强校验：当前 `manifest.ts` / `ParserEngine` 未对"缺失 VERSION.txt 即判定不支持"做逻辑拦截。建议在解压管道（`use-decompress.ts`）中增加校验：解压后若无 `VERSION.txt`，标记 ArchiveItem 为"不支持格式"并提示，符合业务场景"严格遵守"条款。
- `APPLOG*` / `MSGLOG*` 文件类型尚未定义解析插件（当前归入 `log` 或 `hex`）。如后续需要独立展示，按方案 1 的插件模式新增即可，无需改动核心。

---

## 五、实施优先级

| 优先级 | 方案 | 工作量 | 风险 |
|--------|------|--------|------|
| P0 | 方案 1：修复路径型叶子 value | 小 | 低 |
| P1 | 方案 2：双主题适配 | 小 | 低 |
| P1 | 方案 3：搜索防抖 | 小 | 低 |
| P2 | 方案 4：搜索/折叠解耦 | 中 | 低 |
| P3 | 方案 5：性能/体验增强 | 中 | 中 |
| 建议 | VERSION.txt 强校验 | 中 | 低 |

> P0 为功能性 Bug，建议最先修复并补充测试；P1 为体验一致性，可一并提交；P2/P3 按迭代节奏推进。
