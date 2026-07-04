---
kind: frontend_style
name: 基于 Naive UI + CSS 变量主题的前端样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - src/styles/theme.ts
    - src/App.vue
    - src/layout/AppLayout.vue
---

本仓库前端采用 Naive UI 作为桌面级组件库，结合 CSS 自定义属性（CSS Variables）实现全局主题与暗色模式切换，辅以 Vue 单文件组件内 style scoped 的局部样式，形成设计令牌集中定义加组件级作用域的混合风格方案。

## 1. 系统与方法论
- 组件库: Naive UI（NConfigProvider、NMessageProvider、NDialogProvider 等），所有业务组件通过按需导入 N* 组件组合界面，未引入额外 UI 框架或原子类库（无 Tailwind/UnoCSS）。
- 主题机制: 在根组件 App.vue 中通过 NConfigProvider 注入 darkTheme / lightTheme 并叠加 themeOverrides，统一控制主色、错误/警告/成功色及字体族；具体颜色值集中在 src/styles/theme.ts。
- CSS 变量层: 布局与通用视觉语义（背景、边框、文字层级、滚动条、强调色柔化态）以 CSS 变量形式声明于 src/layout/AppLayout.vue 的 :root 下（如 --bg-surface、--border、--text-secondary、--primary、--scrollbar 等），各子组件通过 var(--xxx) 引用，天然支持暗/亮主题切换。
- 样式组织: 除全局变量外，其余样式全部使用 <style scoped> 写在各 .vue 文件中，未见独立 .css/.scss 文件，也未使用 CSS Modules 或 styled-components 等 CSS-in-JS 方案。

## 2. 关键文件与包
- src/styles/theme.ts — Naive UI 全局主题覆盖（主色、语义色、字体族）
- src/App.vue — 挂载 NConfigProvider、NMessageProvider、NDialogProvider，按 store 计算当前 theme
- src/layout/AppLayout.vue — 定义全局 CSS 变量、三栏布局、折叠面板、拖拽上传遮罩等核心样式
- 各业务组件中的 <style scoped> 块（如 UploadZone.vue、ArchiveInfo.vue、PreviewPane.vue、TabBar.vue、JsonRenderer.vue 等）

## 3. 架构与约定
- 设计令牌分层：Naive UI 提供基础按钮/表格/树等控件外观；theme.ts 覆盖品牌色与字体；AppLayout.vue 的 CSS 变量承载应用级布局与排版语义。三层叠加，避免组件直接硬编码颜色。
- 暗色模式开关：由 stores/app.ts 的 isDarkTheme 驱动，App.vue 计算 darkTheme | lightTheme 传入 NConfigProvider，配合 CSS 变量在 :root 下按主题切换取值。
- 组件样式边界：所有组件样式均 scoped，跨组件共享仅通过 CSS 变量与 Naive UI 内置 token 完成，未出现全局 class 污染。
- 构建期无关：Vite 配置未引入 sass/less/postcss/tailwind 插件，样式编译走原生 CSS，保持轻量。

## 4. 开发者应遵循的规则
1. 优先使用 Naive UI 组件：新增界面元素尽量复用 N* 组件，不要手写原生 HTML 控件。
2. 颜色与字体从主题取：禁止在组件中硬编码十六进制颜色；需要新语义色时先在 src/styles/theme.ts 的 GlobalThemeOverrides.common 中扩展，再在 CSS 中以 var(--xxx) 或 Naive token 引用。
3. 布局与通用视觉用 CSS 变量：背景、边框、文字层级、滚动条等放在 AppLayout.vue 的 :root 下统一管理，子组件只引用不重复定义。
4. 样式写在 <style scoped>：新增/修改组件样式时保持在对应 .vue 文件的 scoped 块内，避免新建全局 CSS 文件。
5. 动画与过渡使用 Vue Transition：如主题图标旋转已在 AppLayout.vue 中以 .icon-spin-* 类名配合 Vue transition 实现，新增动效沿用此模式。