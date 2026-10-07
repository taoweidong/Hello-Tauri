# 大模型连接配置基础服务 — 方案分析与实施记录

- 日期：2026-10-02
- 状态：**已实施并完成真实对接**（2026-10-04 阿里云 MaaS compatible-mode，记录见 §11）
- 关联：`docs/design-welink-agent-2026-09-27.md` §3.2（AgentPort）/ §3.3（切换与 Mock）/ §8（配置）/ §11.6（Settings UI）

---

## 1. 需求与解读

原话：「新建基础服务支持配置大模型 API端、API地址和大模型名称，用于消息自动回复时拼接 prompt，
然后把问题发送给大模型，大模型分析并给出结论，自动给用户回复的基础设施……以便后续对接真实的大模型环境。」

口语需求 → 配置字段映射：

| 口语说法   | 配置字段                                                                                 | 说明                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| API 端     | `agent.apiKey`（API 密钥）＋ `agent.endpoint`（接口路径）＋ `agent.apiStyle`（接口风格） | 「API 端」按「API 端点/凭据」理解：密钥走 `Authorization: Bearer` 头，路径即 endpoint，风格决定协议形状 |
| API 地址   | `agent.baseUrl`                                                                          | 内网大模型服务根地址（既有字段）                                                                        |
| 大模型名称 | `agent.model`                                                                            | OpenAI 兼容协议请求体的 `model` 字段，**新增**                                                          |

「拼接 prompt → 发给大模型 → 得出结论 → 自动回复」这段链路在本次之前**已经完整存在**
（pipeline 生成段：`renderPrompt` 组装上下文与触发消息 → `AgentPort.complete` → 草稿落库
`ready` → SafetyGate → welink-cli 外发 → `welink_agent_logs` 全量留痕）。本次补的是**连接层**：
让「大模型」从 mock 变成可配置、可连通、可核对的真实服务。

## 2. 现状盘点（本次之前已具备）

| 能力                                                                            | 位置                                     | 状态                   |
| ------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------- |
| 端口契约 `complete(prompt)` + onCall 留痕钩子                                   | `src/infra/agent/port.ts`                | ✅                     |
| 提示词客户端组装（{{context}}/{{question}}/{{sender}}/{{target}} + 不可信消毒） | `src/infra/agent/prompt.ts`              | ✅                     |
| 确定性 Mock（失败/超时注入，测试与演示用）                                      | `src/infra/agent/mock.ts`                | ✅                     |
| HTTP 适配器（AbortController 超时、timeout/error 分类、内网 literal IP 守卫）   | `src/infra/agent/agent-http.ts`          | ✅（本次扩展协议分支） |
| mock/http 工厂 + 浏览器强制 mock + baseUrl 空回退 + 连通性探测                  | `src/infra/agent/index.ts`               | ✅（本次透传新字段）   |
| 回复管线（两段式 worker、重试、草稿先落库、SafetyGate、防双发）                 | `src/orchestrator/pipeline.ts`           | ✅                     |
| R4 输入输出留痕（`welink_agent_logs` 1:N）                                      | pipeline onCall → repo                   | ✅                     |
| 设置页 Agent 通道（地址/路径/超时/上下文条数/模板 + 连通性测试）                | `src/components/welink/SettingsCard.vue` | ✅（本次加三项控件）   |

结论：**不需要新建并行模块**。`infra/agent` 就是设计文档 §3.1 说的「Agent 交互」基础服务，
上层（pipeline/runtime/Settings）全部只依赖 `AgentPort` —— 扩展它，上层零改动。

## 3. 缺口分析（本次要补的）

1. **无「大模型名称」**：OpenAI 兼容服务必填 `model`，缺失时服务端只回一个含糊的 400。
2. **无「API 密钥」**：企业网关类部署普遍要求 `Authorization: Bearer` 鉴权。
3. **HTTP 适配器只认私有协议**：现协议假设是 `{prompt}` → `{reply}`（为「内网本地 SDK 服务」设计），
   而真实大模型环境的事实标准是 **OpenAI 兼容 `/chat/completions`**
   （vLLM / Ollama / LM Studio / 各家推理网关均提供）。
4. **UI 无对应输入项**：模型名称、密钥、风格选择都无法配置。

## 4. 方案与决策记录

| 决策 | 选择                                                                                  | 理由                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D-A  | 扩展 `infra/agent`，不新建 `infra/llm` 并行模块                                       | 端口、工厂、管线接线、设置页、留痕通道全部现成；新模块等于复制一遍接线且制造两个「Agent 概念」                          |
| D-B  | 协议形状用新维度 `apiStyle: 'simple' \| 'openai'`，而不是新增 `agentSource: 'openai'` | `agentSource` 管「真假」（mock/http），`apiStyle` 管「协议形状」，两者正交；混在一个枚举里会出现 `mock`×风格 的组合爆炸 |
| D-C  | openai 风格把渲染后的完整提示词作为**单条 user 消息**发送                             | 端口契约是 `complete(prompt)`（D3：上下文客户端组装）；拆 system/user 角色等服务端要求明确后再加，不在本期协议里预留    |
| D-D  | openai 风格 `model` 缺失 → 调用时**本机 fail-fast**，不发无效请求                     | 服务端只会回含糊 400/404；本地错误可行动（提示去设置填写），且经 onCall 落 R4 语料可回溯                                |
| D-E  | `apiKey` 明文存 `config.json`（本机数据根），但**绝不进日志、不进 agent_logs**        | config.json 与 `cliPath` 等敏感项同级，已有文件系统边界；日志与留痕语料可能被导出/展示，密钥只允许进请求头              |
| D-F  | 公网 literal IP 守卫对两种风格同样生效                                                | 「对话原文不得出内网」是部署底线，与协议风格无关                                                                        |
| D-G  | 切换接口风格时 endpoint 做「温和纠正」：仅当为空或恰为另一风格的惯用默认值时自动切换  | 消除「切了风格忘了改路径 → 404」的高频误配；绝不覆盖用户手填的自定义路径                                                |

## 5. 配置模型（`config/config.json` → `AppSettings.weLink.agent`）

```jsonc
{
  "agent": {
    "agentSource": "http", // mock | http（真假的开关）
    "apiStyle": "openai", // simple | openai（协议形状，新增）
    "baseUrl": "http://127.0.0.1:11434", // API 地址
    "endpoint": "/v1/chat/completions", // 接口路径（openai 惯用默认）
    "apiKey": "sk-…", // API 密钥，本地免鉴权服务留空（新增）
    "model": "qwen2.5-7b-instruct", // 大模型名称，openai 风格必填（新增）
    "timeoutMs": 60000,
    "maxContextMsgs": 20,
    "promptTemplate": "……",
  },
}
```

归一化（`normalizeWelinkSettings`）三层兜底：老配置缺字段 → 默认值（`simple`/空串）；
非法枚举 → 收敛到 `simple`；错类型 → 空串兜底。老配置文件升级后**无需手工迁移**。

## 6. 两种接口风格

| 维度       | `simple`（内网服务·私有协议）                      | `openai`（OpenAI 兼容）                                                |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| 请求体     | `{ prompt }`                                       | `{ model, messages: [{role:'user', content: prompt}], stream: false }` |
| 鉴权       | 无                                                 | `Authorization: Bearer <apiKey>`（apiKey 非空才带头）                  |
| 响应解析   | 字段名容错（reply/response/result/…/choices 兼容） | `choices[0].message.content`（同一容错函数覆盖）                       |
| model 缺失 | 忽略                                               | 本机 fail-fast 报错                                                    |
| 适用       | 自研内网 SDK 服务（原设计 §1 假设）                | vLLM / Ollama / LM Studio / 企业网关等事实标准                         |

两种风格共享：内网 literal IP 守卫、AbortController 超时中止、timeout/error 分类、
onCall 恒留痕（失败样本也是 R4 语料）、回复正文清洗（`sanitizeReply` 在管线层，风格无关）。

## 7. [LLM-ASSUME] 假设清单（对接真实环境前逐项核实）

与 `[MOCK-CLI]/[CLI-ASSUME]` 同款约定：对接前 `grep -rn "LLM-ASSUME" src/` 逐项核对，
核实后更新或删除标签（当前全部标注在 `src/infra/agent/agent-http.ts` 头注释）：

1. **路径**：`{baseUrl}{endpoint}` 拼接，openai 惯用 `/v1/chat/completions`（用户自配）。
2. **鉴权**：`Authorization: Bearer <apiKey>`；网关若用自定义头（如 `x-api-key`）需改 `buildRequestParts`。
3. **model 必填**：网关若允许缺省 model，可放宽 fail-fast。
4. **消息结构**：完整提示词作单条 user 消息；服务端若要求 system/user 分离（system 设定 + user 问题），
   需在 `buildRequestParts` 拆分（模板首段即系统设定，可按空行分段）。
5. **非流式**：`stream: false` —— 回复草稿要整体落库（要点3），流式无意义；服务端若只支持流式需另行适配。
6. **响应形状**：`choices[0].message.content`；容错已覆盖 data 嵌套与常见字段名。
7. **CORS（对接期最大风险点）**：请求从 WebView2 的 `window.fetch` 发出，origin 是 Tauri webview 源，
   大模型服务**默认不带 CORS 头会被浏览器层拦截**。真实对接时三选一：
   服务端开 CORS（vLLM/Ollama 均支持配置）→ 最省事；
   或改走 Tauri http 插件/Rust 通道（改动集中在 `agent-http.ts` 单文件）；
   或部署同源反代。**桌面模式联调前先确认此项**，浏览器模式（`npm run dev`）强制 mock 无法验证真实连通。

## 8. 对接真实大模型环境 SOP

1. 内网服务就绪，拿到 `baseUrl` / `model` / `apiKey`（如 `http://127.0.0.1:11434` + `qwen2.5:14b`）。
2. 设置页 → WeLink 助手 → Agent 通道：来源=内网 HTTP，接口风格=OpenAI 兼容，填三项，保存（autoSave 即落盘）。
3. 先按第 7 节核实 CORS 与路径（`curl` 打一遍 `/chat/completions` 最直接）。
4. 点「连通性测试」：固定探测 prompt，看耗时与返回摘要（探测走独立实例，不污染 R4 语料）。
5. 建议 `sendMode=manual` 跑几条真实消息：草稿停在「待审」，人工检查质量后放行 —— SafetyGate 全程生效。
6. 观察「Agent 回溯」Tab：latency/error 分布、prompt/response 语料；据此调 `promptTemplate`。
7. 质量稳定后改回 `auto`，让 SafetyGate 的 S1–S8 接管频控。
8. 逐项核实并清理 `[LLM-ASSUME]` 标签，更新本文档状态。

## 9. 测试与验证

- `src/infra/agent/ports.spec.ts`：openai 风格 5 条 —— 请求体形状（model/messages/stream）与
  Bearer 头（trim）、无密钥不带鉴权头、model 缺失 fail-fast 且不发请求（错误仍落语料）、
  标准响应解析 `choices[0].message.content`、公网 IP 守卫对 openai 同样生效。
- `src/types/welink.spec.ts`（新增）：归一化三层兜底 —— 老配置缺字段、非法枚举收敛、
  trim、错类型兜底、出厂默认自带新字段。
- 既有夹具（mock 契约、simple 协议、prompt 渲染、管线全链路）全部保持绿 —— 端口契约未变。

## 10. 本次改动清单

| 文件                                     | 改动                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/types/welink.ts`                    | 新增 `LlmApiStyle`；`WelinkAgentSettings` 增加 `apiStyle/apiKey/model`；默认值与 `normalizeWelinkSettings` 收敛 |
| `src/infra/agent/agent-http.ts`          | `HttpAgentOptions` 扩展；`buildRequestParts` 按风格组装请求头/体；openai model fail-fast；`[LLM-ASSUME]` 标注   |
| `src/infra/agent/index.ts`               | 工厂缓存键纳入新字段；http 实现与连通性探测透传 `apiStyle/apiKey/model`；日志只打风格与模型名（不含密钥）       |
| `src/components/welink/SettingsCard.vue` | Agent 通道新增：接口风格（切换时温和纠正 endpoint）、大模型名称、API 密钥（password 控件）；model 缺失告警      |
| `src/infra/agent/ports.spec.ts`          | openai 风格 5 条用例                                                                                            |
| `src/types/welink.spec.ts`               | 新增：连接配置归一化 5 条用例                                                                                   |
| `AGENTS.md`                              | 模拟替身标注约定纳入 `[LLM-ASSUME]`                                                                             |

## 11. 真实对接记录（2026-10-04，阿里云 MaaS compatible-mode）

真实服务：`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（OpenAI 兼容
端点；模型清单经 `GET /models` 实测：qwen3.8-max/plus/flash、qwen3.6-flash、glm-5.2/5.3、
deepseek-v4-pro/flash 系列等）。本次接入模型 **`qwen3.8-flash`**（自动回复场景优先时延，
设置页可随时改）。API 密钥只落本机数据根 `config.json`（D-E 约定），不入仓库不入日志。

### 11.1 §7 假设逐项核实结果

| #   | 假设                              | 结果（curl 实测）                                                                                                                         |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 路径 `{baseUrl}{endpoint}`        | ✅ baseUrl 含 `/compatible-mode/v1` 前缀，endpoint 配 `/chat/completions`，拼接规则不变                                                   |
| 2   | `Authorization: Bearer <apiKey>`  | ✅（缺头时回 401「No API-key provided」，头名无误）                                                                                       |
| 3   | `model` 必填                      | ✅（保持 D-D 本机 fail-fast，不依赖服务端含糊 400）                                                                                       |
| 4   | 非流式 `stream: false`            | ✅（一次性取全文）                                                                                                                        |
| 5   | 响应 `choices[0].message.content` | ✅；思考型模型（qwen3.8-flash）message 里另有 `reasoning_content` —— pickReply 候选键不含它，只会命中 `content`，思考过程不会混进回复草稿 |
| 6   | CORS                              | ❌ **不成立**：服务端不回 `Access-Control-Allow-Origin`（预检 401、无 CORS 头），WebView 直发 `window.fetch` 会被浏览器层拦截 → 见 11.2   |

消息结构（原假设 6「单条 user 消息」）实测成立，未拆 system/user。

### 11.2 CORS 处置：宿主 HTTP 通道（Rust 薄命令）

§7 三选一里「服务端开 CORS」「同源反代」均不可行（服务不受控），按第二选项落地：

- **Rust 新增第 25 个命令 `http_post_json`**（`src-tauri/src/http.rs`，Bridge `httpPostJson`）：
  通用 JSON POST 薄通道，与 `cli_run` 同构 —— URL/头/体全由 TS 组装，Rust 无业务规则；
  收到 HTTP 响应（含 4xx/5xx）不算错误，仅传输层故障（DNS/TLS/超时）reject；超时宿主侧
  强制生效；响应正文 2MB 截断（同 cli.rs `MAX_OUTPUT` 防洪泛思路）。
- **TLS**：reqwest（tauri 传递依赖）显式开 `native-tls` 特性 —— TLS 交给系统 schannel
  （Windows 组件，不新增可分发 DLL，证书走系统库）。依赖树新增三个纯装配 crate：
  `hyper-tls` / `native-tls` / `schannel`（**内网离线缓存需补这三个**）。
- **`agent-http.ts` 新增可选 `transport`**（组合点注入）：`infra/agent` 工厂在 tauri 运行时
  注入 Bridge 通道，测试与浏览器调试保持 `window.fetch`；端口契约与两种 apiStyle 不变，
  openai/simple 两种风格都经此通道。TS 层超时分类照旧（AbortError → timeout）。
- web 侧 `httpPostJson` 诚实抛错：浏览器模式强制 mock 不发真实请求（业务路径到不了）。

### 11.3 本机配置落位与遗留修复

- `D:\TangYuan\config\config.json` → `weLink.agent`：`agentSource=http`、`apiStyle=openai`、
  baseUrl/endpoint 如上、`model=qwen3.8-flash`、`timeoutMs=60000`、`apiKey=***`。总开关
  `enabled` 保持出厂 `false` —— 由用户在设置页按 SOP 步骤 5–7 逐步开启。
- **配置界面**：Settings 页新增独立的「大模型（Agent）」配置卡（`LlmSettingsCard.vue`，
  `weLink.agent` 块的唯一编辑器）—— 服务地址/接口风格/大模型名称/API 密钥/接口路径/超时/
  上下文条数/提示词模板全部常显可改（原先藏在 WeLink 助手卡 collapse 深处、mock 来源时
  整块不可见）；回复来源（mock/http）开关随块移交；WeLink 助手卡对 agent 块做**透传**
  回写，双卡并存不互踩（契约测试 `LlmSettingsCard.spec.ts` 4 条）。
- `%APPDATA%\com.taowd.hello-tauri\bootstrap.json` 曾被 2026-09-28 一次中断的 uitest 运行
  遗留指向沙箱目录（崩溃导致备份恢复逻辑未执行），已恢复指向 `D:\TangYuan`。
- 验证：`cargo check` 通过；`npm run check` 全绿（lint + typecheck + 962 用例，含新增
  transport 路径 4 条：透传断言 / 4xx → error / 通道故障 → error / 超时 → timeout）。
- 剩余步骤（§8 SOP 4–7，需在桌面模式人工进行）：设置页「连通性测试」→ `sendMode=manual`
  试运行几条真实消息 → 观察「Agent 回溯」语料 → 质量稳定后开 `enabled` + `auto`。

## 12. 协议收敛：只支持 OpenAI 兼容（2026-10-04 二次决策）

真实对接当天确立：**放弃「内网私有 `{prompt}→{reply}` 协议（simple）」支持，全系统只对齐
OpenAI 兼容 `/chat/completions` 一种协议**。理由：本地部署事实标准（Ollama / vLLM /
LM Studio / 企业网关）与公有云 MaaS 全是 OpenAI 形状，私有协议分支没有真实消费方，
只留下「双协议分支 + 风格切换 UI + 温和纠正逻辑」的维护成本。

随决策落地的清理（`apiStyle` 维度整体移除）：

| 层     | 改动                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型   | `LlmApiStyle` / `WelinkAgentSettings.apiStyle` 删除；normalize 静默忽略老配置残留键（无需迁移）；出厂默认改为 `http://127.0.0.1:11434` + `/v1/chat/completions`（Ollama 惯用形状）                                              |
| 适配器 | `agent-http.ts` 单协议重写：请求恒为 `{model, messages, stream:false}` + Bearer；响应**严格解析** `choices[0].message.content`（原字段名容错是 simple 时代的产物），非 OpenAI 形状 / 非 JSON 给出「端点可能不兼容」的可行动报错 |
| UI     | 接口风格选择器与温和纠正逻辑删除；大模型名称 / API 密钥常显；「内网 HTTP」措辞改「模型接口」                                                                                                                                    |
| 守卫   | 公网 literal IP 拦截保留但换前提：模型服务允许公网**域名**（MaaS），literal IP 仍拒（防配置篡改外带对话原文）                                                                                                                   |

影响：仍在用私有协议端点的存量配置对接后会收到「端点可能不是 OpenAI 兼容接口」错误 ——
这是预期的引导信号。本机 `D:\TangYuan\config\config.json` 的残留 `apiStyle` 键已清理。
