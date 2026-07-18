# 验收清单

## 工具模块（csv-row-tree.ts）
- [x] `extractRowTree(headers, row)` 函数存在并导出于 `src/core/csv-row-tree.ts`
- [x] JSON 列识别：当单元格值为合法 JSON 对象/数组时，作为分支节点挂入树中
- [x] 路径型列识别：含 `/`、`\` 或多段 `.` 标识符的值被拆分为嵌套层级（不误判小数如 `3.14`）
- [x] 兜底字段：普通字段作为 `{ 列名: 值 }` 叶子节点挂入根对象
- [x] 空行处理：传入空数组返回空树（空对象或空 children）
- [x] 单元测试 `src/__tests__/core/csv-row-tree.test.ts` 覆盖上述所有分支（41 测试通过）

## 树形节点组件（TreeNode.vue）
- [x] 组件接受 `node`、`depth`、`searchKeyword`、`expandedDepths` props
- [x] 命中搜索关键字的键名/值文本高亮显示（用 v-for + `<mark>` 渲染片段，不使用 v-html）
- [x] 当 `expandedDepths` 不为 null 时，节点展开状态受其控制（受控模式）
- [x] 当 `expandedDepths` 为 null 时，节点使用内部 `open` 状态（非受控模式）
- [x] 叶子节点按类型着色（字符串/数字/布尔/null）

## 详情面板组件（CsvTreeDetail.vue）
- [x] 顶部包含搜索框、全部展开、全部折叠、层级选择器
- [x] 输入搜索关键字时树自动筛选（保留命中 + 祖先路径），匹配文本高亮
- [x] 清空搜索后恢复完整展示且保持原折叠状态
- [x] "全部展开"按钮使所有节点展开
- [x] "全部折叠"按钮使所有非叶子节点折叠
- [x] 层级选择器选择 N 时，树展开至第 N 层（根为第 1 层）
- [x] 组件 emit `close` 事件
- [x] 组件测试 `src/__tests__/components/CsvTreeDetail.test.ts` 覆盖搜索与折叠行为（8 测试通过）

## CsvRenderer 集成
- [x] 点击数据行时高亮该行并在右侧分栏展示树形详情
- [x] 再次点击已选中行可取消选中并关闭分栏
- [x] 切换不同行时右侧详情平滑切换
- [x] CsvTreeDetail 触发 close 事件时 CsvRenderer 正确清空选中状态
- [x] 无选中行时表格保持全宽，向后兼容（原 sample.csv 仍可正常展示）
- [x] 选中行高亮在深色与浅色主题下均清晰可见（使用 `--color-primary-soft` 与 `--color-primary` 主题变量）
- [x] SplitView 分栏可拖拽调整宽度（复用现有 SplitView 组件）
- [x] 保留用户既有的 DataTable 实现（排序/筛选/导出/虚拟滚动）未回滚

## DataTable 扩展
- [x] 新增 `rowClassName` prop 透传给 NDataTable，用于行级样式控制
- [x] 不影响 DataTable 既有功能（既有 10 测试全部通过）

## 类型与导出
- [x] `src/views/renderers/index.ts` 正确导出 CsvTreeDetail 与 TreeNode
- [x] 未修改 `IFileParserPlugin` 接口
- [x] 未修改 `ParsedContent` 类型定义
- [x] 未修改 `csv-plugin.ts` 与 `csv-parser.ts`（保持现有 CSV 解析行为不变）

## 测试与构建
- [x] `npm run typecheck` 通过（vue-tsc --noEmit 退出码 0）
- [x] `npm test` 全部通过（59 文件 / 488 测试）
- [x] `npm run dev` 启动无错误（Vite v8.1.0 在 660ms 内启动，http://localhost:5173/）
- [ ] `data/sample.csv` 手动验证：行点击、切换、关闭、搜索、折叠、层级控制均正常（用户手动）
- [x] JsonRenderer / LogRenderer / TextRenderer 渲染未受影响（相关测试全部通过）
