---
kind: frontend_style
name: Naive UI 主题与组件样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - src/styles/theme.ts
    - src/App.vue
    - package.json
---

本仓库的前端样式基于 Naive UI 2.x 组件库，采用「设计令牌集中 + 全局覆盖 + 组件 scoped 样式」三层架构：

1. **设计令牌（Design Tokens）**：`src/styles/theme.ts` 通过 `GlobalThemeOverrides` 集中定义主色、错误/警告/成功色、字体族等全局变量，作为单一事实来源。

2. **主题切换**：`src/App.vue` 使用 `NConfigProvider` 包裹根应用，根据 Pinia store 中的 `isDarkTheme` 在 `darkTheme` / `lightTheme` 之间切换，并通过 `:theme-overrides` 注入自定义令牌。消息与对话框通过 `NMessageProvider`、`NDialogProvider` 提供全局能力。

3. **组件样式策略**：业务组件普遍采用 `<style scoped>` 局部作用域（如 `views/renderers/*.vue`），避免全局污染；布局级样式集中在各组件内部，不引入外部 CSS 文件。

4. **依赖与构建**：无独立 CSS/SCSS 入口，所有样式由 Vue SFC 内联或 Naive UI 按需导入；Vite 直接处理 `.vue` 中的 `<style>` 块，无需额外 postcss/tailwind 配置。

开发者约定：
- 新增颜色/字体应优先修改 `src/styles/theme.ts`，而非在组件中硬编码。
- 组件样式一律使用 `<style scoped>`，禁止全局 CSS 文件。
- 交互组件统一从 Naive UI 按需 import（如 `NButton`、`NSpace`、`NInput`），不自行封装基础控件。