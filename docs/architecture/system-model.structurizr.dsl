// Hello-Tauri —— 当前态架构模型（C4 真源）
// 生成：system-modeler + c4model ｜ 日期：2026-10-05 ｜ 范围：current-state only
// 证据索引见 system-model.evidence.md（节点/关系 ID 对应 file:line）
// 阅读顺序：L1-system-context → L2-containers → L3-ts-layers
workspace "Hello-Tauri" "Tauri 2 + Vue 3 单文件离线桌面应用的当前态架构模型" "1.0" {

  model {

    // ——— 人 ———
    operator = person "内网办公用户" "使用工作台首页、WeLink 自动回复助手、快速建群、CodeHub 检视、环境诊断" {
      tags "Actor"
      "confidence" "high"
      "sourceRefs" "src/router/index.ts:62-106, AGENTS.md:3-8"
    }

    // ——— 外部系统（本机之外的进程/服务） ———
    welinkCli = softwareSystem "welink-cli" "WeLink 消息与建群 CLI（Windows exe，宿主以子进程调用）" {
      tags "External System"
      "confidence" "high"
      "sourceRefs" "src/infra/welink/welink-cli.ts:34-63, src-tauri/src/cli.rs:36-38"
    }
    codehubCli = softwareSystem "codehub-cli" "内网 CodeHub MR 拉取 CLI（纯只读，token 经 --token 参数注入）" {
      tags "External System"
      "confidence" "medium"
      "note" "契约仍有 35 处 [CLI-ASSUME] 未对真实 CLI 逐项核实"
      "sourceRefs" "src/infra/codehub/codehub-cli.ts:208-242, src-tauri/src/cli.rs:38"
    }
    llmService = softwareSystem "大模型服务（阿里云 MaaS compatible-mode）" "OpenAI 兼容 chat/completions；由宿主代发 POST 绕开 WebView CORS" {
      tags "External System"
      "confidence" "high"
      "sourceRefs" "src/infra/agent/agent-http.ts:11-15, src/api/tauri.ts:65-66"
    }
    ragService = softwareSystem "知识检索服务（RAG）" "按 query + topK + filter 取知识片段；与 Agent 同款 JSON POST 通道" {
      tags "External System"
      "confidence" "low"
      "note" "6 处 [RAG-ASSUME]：路径/鉴权/响应形状/字段名/score 语义均未对真实服务核实"
      "sourceRefs" "src/infra/rag/rag-http.ts:6,105, src/infra/rag/port.ts:11-25"
    }
    windowsOs = softwareSystem "Windows 操作系统能力" "System32 只读诊断命令、系统信息探测、剪贴板/通知/打开、数据根文件系统" {
      tags "External System"
      "confidence" "high"
      "sourceRefs" "src-tauri/src/cli.rs:36-56, src-tauri/src/sysinfo.rs, src-tauri/src/shell.rs"
    }

    // ——— 被建模系统 ———
    hello = softwareSystem "Hello-Tauri 个人工作台" "单文件离线 exe（仅 Windows）；三大技术域 + 聚合各域的工作台首页" {
      tags "System"
      "confidence" "high"
      "sourceRefs" "AGENTS.md:3-8, src-tauri/src/lib.rs:13-54"

      webview = container "WebView 前端（业务逻辑 100% 在此）" "Vue 3 + Element Plus + Pinia + TypeScript，Vite 构建" {
        tags "Application"
        "confidence" "high"
        "sourceRefs" "src/main.ts, src/router/index.ts, src/views/"

        viewsL3 = component "Views / Components" "页面与组件：工作台、WeLink、快速建群、CodeHub、配置、环境检测、表格 CRUD" {
          tags "Layer"
          "confidence" "high"
          "sourceRefs" "src/views/*.vue, src/components/**, src/layouts/MainLayout.vue"
        }
        storesL3 = component "Stores（Pinia）" "状态管理 + 装配点：调 orchestrator 生命周期，并注入 infra 工厂做装配" {
          tags "Layer"
          "confidence" "high"
          "sourceRefs" "src/stores/welink/index.ts:24, src/stores/codehub.ts:13-23, src/stores/group.ts:15-22"
        }
        orchL3 = component "Orchestrator（组合根 + 调度）" "runtime 组装端口/仓储/闸口；poller 轮询、pipeline 生成与外发（技能路由 → RAG 检索 → 草稿 → 闸门 → 发送）、bootstrap 恢复、retention 清理、group 建群、codehub-sync/detail、skill-router" {
          tags "Layer"
          "confidence" "high"
          "sourceRefs" "src/orchestrator/runtime.ts:71-221, src/orchestrator/pipeline.ts:87-495, pipeline.ts:242-268"
        }
        gateL3 = component "Safety Gate（外发闸门）" "所有外发必经：开关分级/配额/最小间隔/静默时段/草稿体检/熔断；check 为纯判定，配额只在 onSent 扣减" {
          tags "Control"
          "confidence" "high"
          "sourceRefs" "src/orchestrator/safety-gate.ts:1-130, src/orchestrator/pipeline.ts:383-437"
        }
        infraL3 = component "Infra（端口-适配器 ×7）" "welink / agent / db / envcheck / windows / codehub / rag：Port 接口 + mock 替身 + 真实实现，按 platform 与设置切换" {
          tags "Layer"
          "confidence" "high"
          "sourceRefs" "src/infra/welink/index.ts:45, src/infra/agent/index.ts:39, src/infra/rag/index.ts:30, src/infra/db/index.ts:63-98"
        }
        reposL3 = component "Repositories（遗留 records 域）" "records 表 CRUD + CSV 导出；桌面=SQLite、浏览器=内存后端" {
          tags "Layer"
          "confidence" "high"
          "sourceRefs" "src/repositories/records.ts:170-310, src/repositories/csv.ts"
        }
        bridgeL3 = component "src/api Bridge（唯一宿主出口）" "运行时按 __TAURI_INTERNALS__ 选 tauri.ts（invoke）或 web.ts（localStorage）" {
          tags "Gateway"
          "confidence" "high"
          "sourceRefs" "src/api/index.ts:1-10, src/api/tauri.ts:46-76, src/api/web.ts"
        }
      }

      rustHost = container "Rust 宿主（薄桥接，零业务规则）" "Tauri 2 命令面共 25 个：commands 9 / db 4 / fs 2 / cli 1 / http 1 / sysinfo 4 / shell 4" {
        tags "Application"
        "confidence" "high"
        "sourceRefs" "src-tauri/src/lib.rs:23-51"

        cliCmd = component "cli.rs 子进程通道" "ALLOWED_STEMS 白名单为最后一道闸；stdout 以 base64 回传，UTF-8→GBK 判定留给 TS" {
          tags "Component"
          "confidence" "high"
          "sourceRefs" "src-tauri/src/cli.rs:36-56, src-tauri/src/cli.rs:217"
        }
        httpCmd = component "http.rs JSON POST 通道" "宿主代发大模型请求（WebView fetch 受 CORS 拦截）" {
          tags "Component"
          "confidence" "high"
          "sourceRefs" "src-tauri/src/http.rs, src/api/tauri.ts:65-66"
        }
        dbCmd = component "db.rs 通用 SQL 通道" "db_migrate/db_select/db_execute/db_transaction；Rust 不知表结构；禁 ATTACH" {
          tags "Component"
          "confidence" "high"
          "sourceRefs" "src-tauri/src/db.rs:18-225"
        }
      }

      dataRoot = container "本机数据根" "默认 D:\\TangYuan；由 %APPDATA%\\com.taowd.hello-tauri\\bootstrap.json 固定引导，可在配置页整体迁移。内容：config/config.json、data/app.db（SQLite WAL，migration v1–v5）、data/table.json、logs/app-*.log（留 30 天）、knowledge/*.md + knowledge/index.json（RAG 知识源与清单真源，走 fs_read/fs_write，不入 SQLite）" {
        tags "Storage"
        "confidence" "high"
        "sourceRefs" "src-tauri/src/storage.rs:13-17, src-tauri/src/storage.rs:78-127, src/infra/db/index.ts:35, AGENTS.md:82-86"
      }
    }

    // ——— 关系：人机 ———
    operator -> webview "操作工作台与三大业务域页面" {
      "type" "uses"
      "sync" "sync"
      "confidence" "high"
    }

    // ——— 关系：前端分层（依赖自上而下） ———
    viewsL3 -> storesL3 "读写状态；UI 层禁止直触 infra/repositories（ESLint 闸门）" {
      "type" "depends-on"
      "confidence" "high"
      "sourceRefs" "eslint.config.mjs:142-155, src/components/group/CreateTab.vue:23"
    }
    viewsL3 -> bridgeL3 "既有事实：6 个 UI 文件直连 Bridge（闸门只禁 @/infra/** 与 @/repositories/**，未禁 @/api）" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/components/welink/KnowledgeCard.vue:16,48-133, src/views/DashboardView.vue, src/views/GroupView.vue, src/views/SettingsView.vue, src/components/welink/SettingsCard.vue, src/components/group/CreateTab.vue"
    }
    storesL3 -> orchL3 "启动/停止/急停/立即拉取/立即清理" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/stores/welink/index.ts:24, src/stores/group.ts:22, src/stores/codehub.ts:17-23"
    }
    storesL3 -> infraL3 "组合点例外：注入 infra 工厂（envcheck / groupClient / codeHubPort / 仓储后端）" {
      "type" "depends-on"
      "confidence" "high"
      "sourceRefs" "src/stores/envcheck.ts:21, src/stores/group.ts:15-18, src/stores/codehub.ts:13-15, src/stores/table.ts:5-6"
    }
    storesL3 -> bridgeL3 "配置读写、appInfo/storageInfo" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/stores/app.ts:35-59"
    }
    orchL3 -> infraL3 "只经 Port 接口与仓储实例，不感知真实实现" {
      "type" "depends-on"
      "confidence" "high"
      "sourceRefs" "src/orchestrator/runtime.ts:14-16, src/orchestrator/pipeline.ts:1-30"
    }
    orchL3 -> gateL3 "外发 worker 在 send 之前调 check()" {
      "type" "validates"
      "confidence" "high"
      "sourceRefs" "src/orchestrator/pipeline.ts:383"
    }
    infraL3 -> bridgeL3 "Bridge 是 infra 触达宿主的唯一通道" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/infra/welink/exec.ts:16, src/infra/db/repos/welink.ts:13, src/infra/agent/index.ts:11"
    }
    reposL3 -> bridgeL3 "records 表 SQL + legacy table.json 兜底" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/repositories/records.ts:170-229"
    }
    bridgeL3 -> rustHost "invoke（25 个命令）" {
      "type" "calls"
      "sync" "sync"
      "protocol" "Tauri IPC"
      "confidence" "high"
      "sourceRefs" "src/api/tauri.ts:46-76, src-tauri/src/lib.rs:23-51"
    }

    // ——— 关系：宿主 → 外部世界 / 数据 ———
    rustHost -> welinkCli "cli_run 子进程：list / pull / send / doctor / help / create-group" {
      "type" "calls"
      "protocol" "子进程 + stdout(base64)"
      "confidence" "high"
      "sourceRefs" "src/infra/welink/commands.ts:34-82, src/infra/welink/exec.ts:58-86"
    }
    rustHost -> codehubCli "cli_run 子进程：MR 列表 / 单条 view / auth status（只读，无外发）" {
      "type" "calls"
      "protocol" "子进程 + stdout(base64)"
      "confidence" "medium"
      "sourceRefs" "src/infra/codehub/codehub-cli.ts:208-242"
    }
    rustHost -> llmService "http_post_json：生成回复草稿；apiKey 只存本机 config.json、不入仓库" {
      "type" "calls"
      "protocol" "HTTPS JSON"
      "confidence" "high"
      "sourceRefs" "src/infra/agent/agent-http.ts:125-163, AGENTS.md:70-73"
    }
    rustHost -> ragService "http_post_json：知识检索取回片段（与 Agent 共用同一条宿主代发通道）" {
      "type" "calls"
      "protocol" "HTTPS JSON"
      "confidence" "low"
      "sourceRefs" "src/infra/rag/index.ts:26, src/infra/rag/rag-http.ts:130-163"
    }
    rustHost -> windowsOs "白名单 System32 只读命令 + 系统信息 + 剪贴板/通知/打开目录" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src/infra/windows/registry.ts:39-111, src-tauri/src/cli.rs:36-56"
    }
    rustHost -> dataRoot "读写 config/日志/快照，迁移存储根" {
      "type" "reads"
      "confidence" "high"
      "sourceRefs" "src-tauri/src/storage.rs:163-293"
    }
    dbCmd -> dataRoot "执行 TS 下发的迁移与 SQL（app.db WAL）" {
      "type" "reads"
      "confidence" "high"
      "sourceRefs" "src-tauri/src/db.rs:18-107"
    }
    cliCmd -> welinkCli "welink-cli 与 codehub-cli 共用这一条子进程通道" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src-tauri/src/cli.rs:217"
    }
    httpCmd -> llmService "宿主代发" {
      "type" "calls"
      "confidence" "high"
      "sourceRefs" "src-tauri/src/http.rs"
    }
  }

  views {
    systemContext hello "L1-system-context" "系统上下文：谁在用、连了哪些外部世界、边界在哪" {
      autoLayout
    }

    container hello "L2-containers" "容器视图：单 exe 内三个容器 + 四个外部系统" {
      autoLayout
    }

    component webview "L3-ts-layers" "前端 TS 分层、两道闸门与唯一宿主出口" {
      autoLayout
    }

    component rustHost "L3-rust-channels" "Rust 侧三条关键通道（cli / http / db）" {
      autoLayout
    }
  }
}
