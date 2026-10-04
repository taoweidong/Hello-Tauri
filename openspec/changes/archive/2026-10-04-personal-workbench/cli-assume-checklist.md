# codehub-cli 对接核对清单（personal-workbench 7.3）

`[CLI-ASSUME]` = 对真实 codehub-cli 的**假设**，对接前必须逐项核实，核实后更新或删除对应标签；
`[MOCK-CLI]` = 模拟替身，对接后**保留**（单测替身 + 浏览器调试数据源）。

重新生成本清单的原始结果：

```bash
grep -rn "CLI-ASSUME\|MOCK-CLI" src/
```

本变更只新增 CodeHub 域（下表 1–9 与「替身」清单）；`src/infra/welink/**`、
`src/infra/envcheck/**`、`src/infra/windows/**`、`src/infra/agent/**` 的同款标签属历史变更，
对接对应外部世界时另跑上面的 grep。

## 一、CodeHub `[CLI-ASSUME]`（对接真实 codehub-cli 时逐项打勾）

| # | 位置 | 假设内容 | 核实动作 |
| - | ---- | -------- | -------- |
| 1 | `src/infra/codehub/codehub-cli.ts:8-11` | 子命令面：`auth status`（退出码 0 即连通）、`mr list --repo <id> [--state <s>] --limit <n> --format json`、`mr view <iid> --repo <id> --format json` | 用 `--help` / 真实 CLI 逐个确认子命令名与参数拼写；不一致只改 `listArgs` / `viewArgs` / `verifyConnection` |
| 2 | `src/infra/codehub/exec.ts:29`（`TOKEN_FLAG`） | token 以全局参数 `--token <值>` 注入，且置于子命令之前 | 核实参数名与位置；若真实 CLI 只认环境变量，改 `exec.ts` 的注入方式并同步 `CodehubSettingsCard.vue:11` 的提示文案 |
| 3 | `src/infra/codehub/codehub-cli.ts:14` | 输出为 UTF-8 文本；`list` 回 JSON 数组、`view` 回 JSON 对象（`codehub-cli.ts:227`） | 实测两个子命令的输出形态；GBK/带 BOM 时接 `utils/b64.ts` 的解码兜底 |
| 4 | `src/infra/codehub/codehub-cli.ts:82-88` | 状态取值：`opened/open → open`、`merged → merged`、`closed/rejected → closed`，其余视为 parse 故障 | 取真实状态全集，补进 `normalizeState`（或收窄候选清单） |
| 5 | `src/infra/codehub/codehub-cli.ts:130-148` | 列表字段候选名：`iid/mr_iid/number/id`、`title`、`author/author_name/username`、`source_branch`、`target_branch`、`updated_at`、`web_url/html_url` | 用真实 JSON 样本核对；确认后即可删掉多余候选（假设面越窄越安全） |
| 6 | `src/infra/codehub/codehub-cli.ts:91-107` | 检视摘要字段：`reviewers`（人名/工号数组）、`approvals/approve_count`、`unresolved_comments/unresolved`、`last_activity_at`；缺失回落 0/空而不丢整条记录 | 核实字段是否存在于 `list` 输出；若只在 `view` 里才有，把摘要改由详情补拉填充 |
| 7 | `src/infra/codehub/codehub-cli.ts:110-123` | 评论字段：`comments[]` 元素含 `author/username/name`、`body/content`、`created_at/createdAt`；**字段缺失**＝详情不可得（触发点开补拉），**空数组**＝合法「确实没有评论」 | 核实 `list` 是否携带 `comments`；若 list 恒不带，则「点开补拉」会成为每次浏览的必经调用，需在 UI 上另行提示 |
| 8 | `src/infra/codehub/codehub-cli.ts:157-203`、`port.ts:9` | 2MB 截断兜底：`list` 被腰斩时按花括号深度抢救完整元素，残缺元素丢弃并置 `degraded`（详见 design D5） | 核实真实 CLI 是否会自带分页/上限从而不会出现截断；截断语义变化时同步 design D5 与检视页降级条 |
| 9 | `src/infra/codehub/exec.ts:48`（`AUTH_PATTERN`） | 认证失败的特征串（token 失效/无权限） | 取真实错误文案补进模式，保证「认证失败」能与「通道故障」区分（后者才退避重试） |
| 10 | `src/types/codehub.ts:22`、`types/codehub.ts:111` | 仓库标识形态（`空间/仓库` 路径式）与 `--limit` 服务端上限未知 | 核实 repoId 真实形态与上限；上限确认后与 `CODEHUB_MAX_BATCH` 取小并更新 `CodehubSettingsCard.vue` 的批上限提示 |

**核对完的收尾动作**：删除或改写源码里对应的 `[CLI-ASSUME]` 标签，并把本表的「核实动作」列改
成结论；Rust 侧白名单（`src-tauri/src/cli.rs` 的 `ALLOWED_STEMS`）此时已含 `codehub-cli`，
无需再动。

## 二、CodeHub `[MOCK-CLI]` 替身（对接后保留）

| 位置 | 替身内容 |
| ---- | -------- |
| `src/infra/codehub/index.ts:4` | mock/cli 切换点：真实契约核实后不改这里，只改适配器文件 |
| `src/infra/codehub/mock.ts:4` | 固定夹具（三仓库 × 三状态），含确定性故障注入（transport/parse 计数）与 `degraded` 恒 false |
| `src/infra/codehub/mock.ts:208/212/246` | 注入故障与连通验证的模拟返回（`verifyConnection` 恒可用是模拟语义） |
| `src/infra/codehub/ports.spec.ts:6` | mock 端口契约测试（打桩期的行为基准，对接后用同款用例钉住真实适配器） |

mock 的两处「与真实行为的差异」需要对接时特别留意：无游标/增量语义（每轮全量重拉），
以及 list 缺详情的那条夹具在 view 侧另有载荷（`mock.ts` 的 `MOCK_MR_DETAILS`）。
