/**
 * 设置页「改动即上抛」的统一防抖节奏（毫秒）。
 *
 * 六张配置卡（WeLink 通用 / 大模型 / RAG / 知识沉淀、CodeHub、自动更新）都是
 * `deep watch → 防抖 → emit + applySettings` 的同款结构。节奏必须一致：同一页
 * 里有的卡 200ms、有的卡 500ms，会让「改完多久生效」变成看卡片的玄学；测试也
 * 会各自拿数字对齐，改一处漏一处。
 *
 * 300ms 的选择：足以合并连续输入/拖动的中间态，又不至于让用户在切换页面时
 * 等不到最后一次落盘（各卡在 onBeforeUnmount 只清定时器，不补 flush）。
 */
export const SETTINGS_PUSH_DEBOUNCE_MS = 300
