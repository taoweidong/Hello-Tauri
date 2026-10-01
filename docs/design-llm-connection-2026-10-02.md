# 大模型连接配置基础服务 — 方案分析与实施记录

- 日期：2026-10-02
- 状态：**已实施**（基础设施就绪，真实大模型环境待对接）
- 关联：`docs/design-welink-agent-2026-09-27.md` §3.2（AgentPort）/ §3.3（切换与 Mock）/ §8（配置）/ §11.6（Settings UI）

---

## 1. 需求与解读

原话：「新建基础服务支持配置大模型 API端、API地址和大模型名称，用于消息自动回复时拼接 prompt，
然后把问题发送给大模型，大模型分析并给出结论，自动给用户回复的基础设施……以便后续对接真实的大模型环境。」

口语需求 → 配置字段映射：

| 口语说法 | 配置字段 | 说明 |
| --- | --- | --- |
| API 端 | `agent.apiKey`（API 密钥）＋ `agent.endpoint`（接口路径）＋ `agent.apiStyle`（接口风格） | 「API 端」按「API 端点/凭据」理解：密钥走 `Authorization: Bearer` 头，路径即 endpoint，风格决定协议形状 |
| API 地址 | `agent.baseUrl` | 内网大模型服务根地址（既有字段） |
| 大模型名称 | `agent.model` | OpenAI 兼容协议请求体的 `model` 字段，**新增** |

「拼接 prompt → 发给大模型 → 得出结论 → 自动回复」这段链路在本次之前**已经完整存在**
（pipeline 生成段：`renderPrompt` 组装上下文与触发消息 → `AgentPort.complete` → 草稿落库
`ready` → SafetyGate → welink-cli 外发 → `welink_agent_logs` 全量留痕）。本次补的是**连接层**：
让「大模型」从 mock 变成可配置、可连通、可核对的真实服务。

## 2. 现状盘点（本次之前已具备）

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 端口契约 `complete(prompt)` + onCall 留痕钩子 | `src/infra/agent/port.ts` | ✅ |
| 提示词客户端组装（{{context}}/{{question}}/{{sender}}/{{target}} + 不可信消毒） | `src/infra/agent/prompt.ts` | ✅ |
| 确定性 Mock（失败/超时注入，测试与演示用） | `src/infra/agent/mock.ts` | ✅ |
| HTTP 适配器（AbortController 超时、timeout/error 分类、内网 literal IP 守卫） | `src/infra/agent/agent-http.ts` | ✅（本次扩展协议分支） |
| mock/http 工厂 + 浏览器强制 mock + baseUrl 空回退 + 连通性探测 | `src/infra/agent/index.ts` | ✅（本次透传新字段） |
| 回复管线（两段式 worker、重试、草稿先落库、SafetyGate、防双发） | `src/orchestrator/pipeline.ts` | ✅ |
| R4 输入输出留痕（`welink_agent_logs` 1:N） | pipeline onCall → repo | ✅ |
| 设置页 Agent 通道（地址/路径/超时/上下文条数/模板 + 连通性测试） | `src/components/welink/SettingsCard.vue` | ✅（本次加三项控件） |

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

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| D-A | 扩展 `infra/agent`，不新建 `infra/llm` 并行模块 | 端口、工厂、管线接线、设置页、留痕通道全部现成；新模块等于复制一遍接线且制造两个「Agent 概念」 |
| D-B | 协议形状用新维度 `apiStyle: 'simple' \| 'openai'`，而不是新增 `agentSource: 'openai'` | `agentSource` 管「真假」（mock/http），`apiStyle` 管「协议形状」，两者正交；混在一个枚举里会出现 `mock`×风格 的组合爆炸 |
| D-C | openai 风格把渲染后的完整提示词作为**单条 user 消息**发送 | 端口契约是 `complete(prompt)`（D3：上下文客户端组装）；拆 system/user 角色等服务端要求明确后再加，不在本期协议里预留 |
| D-D | openai 风格 `model` 缺失 → 调用时**本机 fail-fast**，不发无效请求 | 服务端只会回含糊 400/404；本地错误可行动（提示去设置填写），且经 onCall 落 R4 语料可回溯 |
| D-E | `apiKey` 明文存 `config.json`（本机数据根），但**绝不进日志、不进 agent_logs** | config.json 与 `cliPath` 等敏感项同级，已有文件系统边界；日志与留痕语料可能被导出/展示，密钥只允许进请求头 |
| D-F | 公网 literal IP 守卫对两种风格同样生效 | 「对话原文不得出内网」是部署底线，与协议风格无关 |
| D-G | 切换接口风格时 endpoint 做「温和纠正」：仅当为空或恰为另一风格的惯用默认值时自动切换 | 消除「切了风格忘了改路径 → 404」的高频误配；绝不覆盖用户手填的自定义路径 |

## 5. 配置模型（`config/config.json` → `AppSettings.weLink.agent`）

```jsonc
{
  "agent": {
    "agentSource": "http",              // mock | http（真假的开关）
    "apiStyle": "openai",               // simple | openai（协议形状，新增）
    "baseUrl": "http://127.0.0.1:11434",// API 地址
    "endpoint": "/v1/chat/completions", // 接口路径（openai 惯用默认）
    "apiKey": "sk-…",                   // API 密钥，本地免鉴权服务留空（新增）
    "model": "qwen2.5-7b-instruct",     // 大模型名称，openai 风格必填（新增）
    "timeoutMs": 60000,
    "maxContextMsgs": 20,
    "promptTemplate": "……"
  }
}
```

归一化（`normalizeWelinkSettings`）三层兜底：老配置缺字段 → 默认值（`simple`/空串）；
非法枚举 → 收敛到 `simple`；错类型 → 空串兜底。老配置文件升级后**无需手工迁移**。

## 6. 两种接口风格

| 维度 | `simple`（内网服务·私有协议） | `openai`（OpenAI 兼容） |
| --- | --- | --- |
| 请求体 | `{ prompt }` | `{ model, messages: [{role:'user', content: prompt}], stream: false }` |
| 鉴权 | 无 | `Authorization: Bearer <apiKey>`（apiKey 非空才带头） |
| 响应解析 | 字段名容错（reply/response/result/…/choices 兼容） | `choices[0].message.content`（同一容错函数覆盖） |
| model 缺失 | 忽略 | 本机 fail-fast 报错 |
| 适用 | 自研内网 SDK 服务（原设计 §1 假设） | vLLM / Ollama / LM Studio / 企业网关等事实标准 |

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

| 文件 | 改动 |
| --- | --- |
| `src/types/welink.ts` | 新增 `LlmApiStyle`；`WelinkAgentSettings` 增加 `apiStyle/apiKey/model`；默认值与 `normalizeWelinkSettings` 收敛 |
| `src/infra/agent/agent-http.ts` | `HttpAgentOptions` 扩展；`buildRequestParts` 按风格组装请求头/体；openai model fail-fast；`[LLM-ASSUME]` 标注 |
| `src/infra/agent/index.ts` | 工厂缓存键纳入新字段；http 实现与连通性探测透传 `apiStyle/apiKey/model`；日志只打风格与模型名（不含密钥） |
| `src/components/welink/SettingsCard.vue` | Agent 通道新增：接口风格（切换时温和纠正 endpoint）、大模型名称、API 密钥（password 控件）；model 缺失告警 |
| `src/infra/agent/ports.spec.ts` | openai 风格 5 条用例 |
| `src/types/welink.spec.ts` | 新增：连接配置归一化 5 条用例 |
| `AGENTS.md` | 模拟替身标注约定纳入 `[LLM-ASSUME]` |
