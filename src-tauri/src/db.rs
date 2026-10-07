use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::{ToSql, Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::logging;
use crate::storage;

/// SQLite 连接：单连接 + Mutex 包装。rusqlite 的 Connection 非 Sync，
/// 桌面单机并发极低，一把锁足够，且天然串行化写操作。
pub struct Db(pub Mutex<Connection>);

/// 打开（必要时创建）存储根下的 app.db，WAL 模式提升并发读性能。
pub fn open_db(app: &AppHandle) -> Result<Db, String> {
    let layout = storage::resolve_storage(app);
    let path = Path::new(&layout.db_file);
    // 建不出数据目录时**降级为内存库**，而不是返回 Err。
    //
    // 为什么不能 `?`（2026-10-07 实测）：`open_db` 由 `setup` 调用，错误会冒成
    // 「Failed to setup app」→ Tauri panic → 进程 abort（`panic = "abort"`）。
    // 而 abort 来不及回收 WebView2 子进程，孤儿会占住 WebView2 profile，
    // 让之后**每一次**启动都白屏 —— 一个「存储路径写不了」的小问题被放大成
    // 「应用再也起不来」。触发场景很现实：路径被文件占位、磁盘只读、
    // 或安全软件拦截非系统盘程序写 AppData。
    // 降级后前端仍能启动，并从 storage_info 的 note 里看到不可用原因。
    let prepared = match path.parent() {
        Some(parent) => std::fs::create_dir_all(parent).map_err(|error| error.to_string()),
        None => Ok(()),
    };
    let conn = match prepared {
        Ok(()) => Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?,
        Err(reason) => {
            eprintln!("数据目录不可用（{reason}），本次会话降级为内存数据库（不落盘）");
            Connection::open_in_memory().map_err(|e| format!("打开内存数据库失败: {e}"))?
        }
    };
    // WAL 需要目录可写；失败时退回默认 journal 模式而不是让整个应用起不来
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    Ok(Db(Mutex::new(conn)))
}

/// WAL 检查点逻辑已并入 storage::do_migrate 的独占锁窗口（评审 P1）：
/// checkpoint 与目录复制之间绝不能放开连接，否则两者之间的写入又落回 -wal。

fn with_db<R, F: FnOnce(&mut Connection) -> Result<R, String>>(
    app: &AppHandle,
    f: F,
) -> Result<R, String> {
    let db = app.state::<Db>();
    // 中毒锁恢复：这里串行访问，且持锁期间不会 panic（panic = "abort"），
    // 因此 unwrap_or_else 只是防御性写法，实际不会走到 poisoned 分支
    let mut conn = db
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut conn)
}

/// 迁移期间独占数据库连接执行一段工作（评审 P1）。
///
/// 复制 app.db 时绝不能有并发读写：写命令会把新数据写进**正在被复制的旧根**
/// （重启切到新根后这部分静默丢失），读命令也可能读到复制中途的不一致状态。
/// 持锁窗口 = WAL checkpoint + 整个目录复制，期间所有 DB 命令在此排队。
/// 只有 storage::migrate_data_dir 一个调用方；成功后的持续写入拒绝由
/// storage 的 STORE_FROZEN 状态机负责，不在这里做。
pub fn with_db_exclusive<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<R, String>,
) -> Result<R, String> {
    let db = app.state::<Db>();
    let mut conn = db.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut conn)
}

/// 把一段同步 DB 工作丢进阻塞线程池（D3）。
///
/// **为什么四个命令都必须 async + spawn_blocking**（与 `cli.rs` 的 D9 同一条理由）：
/// Tauri 的**同步**命令在 WebView 主线程上执行，一旦 SQL 变慢就直接卡死 UI
/// （掉帧/白屏）。这里承载的几条读路径并不廉价：
///  * `db_select` ← `listInbox`（JOIN + GROUP BY + 关联子查询）、
///    `listJobs`（双 LEFT JOIN，limit 数百）、`recentContext`；
///  * `db_transaction` ← `applyPollResult`（一批消息 N 条 INSERT + 建 job + 汇总列 UPDATE）；
///  * `db_migrate` ← 建表 + 建索引的批量 DDL。
/// 千级数据下察觉不到，但这是**随数据量线性恶化**的隐患，不是「暂时够用」。
/// 早期版本四个命令都是同步的，与 `cli.rs` 里已经改对的写法自相矛盾 —— 这里统一。
///
/// 外层错误是 JoinError（线程 panic/被取消），内层是业务错误，两层都要透传。
async fn run_blocking_db<R, F>(task: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce() -> Result<R, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("数据库执行线程异常退出：{error}"))?
}

/// serde JSON 值 → SQLite 参数。数组/对象在 SQL 层没有对应标量类型，直接拒绝。
fn to_sql_value(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                SqlValue::Integer(int)
            } else if let Some(real) = number.as_f64() {
                SqlValue::Real(real)
            } else {
                return Err(format!("无法绑定的数字: {number}"))
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Array(_) | Value::Object(_) => return Err("参数不支持数组或对象".to_string()),
    })
}

fn bind_values(params: &[Value]) -> Result<Vec<SqlValue>, String> {
    params.iter().map(to_sql_value).collect()
}

/// 借用列表转 &dyn ToSql 引用序列，供 params_from_iter 绑定。
fn as_params(bound: &[SqlValue]) -> Vec<&dyn ToSql> {
    bound.iter().map(|value| value as &dyn ToSql).collect()
}

/// SQLite 列值 → JSON 值。当前业务无 BLOB，遇到时以占位符保留列而不打断表驱动 UI。
fn column_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(int) => {
            if int.unsigned_abs() <= 2u64.pow(53) {
                Value::from(int)
            } else {
                // 超 2^53 转字符串（评审 R-3）：转 f64 会静默丢精度且调用方无从
                // 分辨（雪花 ID 类大整数回表查询会静默错行）；字符串可原样回传，
                // 绑定回查时 SQLite 按 INTEGER 列亲和性把数字文本转回整数，等值匹配仍成立。
                Value::from(int.to_string())
            }
        }
        ValueRef::Real(real) => Value::from(real),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(_) => Value::String("[blob]".to_string()),
    }
}

/// db_select 行数硬顶（评审 R-2）：忘写 LIMIT 的失控查询会把整表拉进内存再经
/// IPC 序列化。业务分页上限远小于此值；触顶**报错**而非静默截断——调用方必须
/// 显式表达分页意图，截断会让「数据全量吗」永远无法从返回值判断。
const MAX_SELECT_ROWS: usize = 10_000;

fn rows_to_json(
    conn: &mut Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Map<String, Value>>, String> {
    guard_statement(sql)?;
    let bound = bind_values(params)?;
    let mut statement = conn
        .prepare(sql)
        .map_err(|error| format!("SQL 准备失败: {error}"))?;
    let names: Vec<String> = (0..statement.column_count())
        .map(|index| statement.column_name(index).unwrap_or_default().to_string())
        .collect();
    let mut rows = statement
        .query_map(rusqlite::params_from_iter(as_params(&bound)), |row| {
            let mut map = Map::with_capacity(names.len());
            for (index, name) in names.iter().enumerate() {
                let json = row
                    .get_ref(index)
                    .map(column_json)
                    .unwrap_or(Value::Null);
                map.insert(name.clone(), json);
            }
            Ok(map)
        })
        .map_err(|error| format!("查询失败: {error}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next() {
        if out.len() >= MAX_SELECT_ROWS {
            return Err(format!(
                "查询结果超过 {MAX_SELECT_ROWS} 行，请增加过滤条件或使用 LIMIT 分页"
            ));
        }
        out.push(row.map_err(|error| format!("读取行失败: {error}"))?);
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// 受影响行数
    pub changes: usize,
    /// 最近插入行的 rowid（INSERT 时有意义）
    pub last_insert_id: i64,
}

/// 被拒绝的 SQL 前缀/关键字（S-2 的语句种类闸口）。
///
/// **威胁模型（重要，改动前先读）**：本通道的调用方是**打包进 exe 的前端代码**，
/// 不是任意脚本 —— 能改前端就得重新打包，已经等价于「能改程序」。所以这里**不是**
/// 在防御「已攻陷的前端」，而是防两件事：
///
///  1. **误用**：业务代码里一句手滑的 `ATTACH DATABASE 'D:\x.db'` 会把存储根
///     悄悄连出去，之后所有表都可能落在预期之外的位置，且现场极难排查；
///  2. **注入放大**：若将来某处把用户输入拼进了 SQL（而不是用 `?1` 绑定），
///     这些关键字是最具破坏力的一类载荷。
///
/// 因此判据刻意**保守但可解释**：命中即为错误并记录明确原因，不做静默忽略。
/// 注意这是**字符串层**检查，不做完整 SQL 解析 —— 它的定位是「挡住明显的越界
/// 语句种类」，真正的安全保证仍然来自「SQL 全在 TS、参数一律绑定」。
const FORBIDDEN_SQL: &[(&str, &str)] = &[
    ("attach", "禁止 ATTACH DATABASE：业务数据库只应有一个（存储根下的 app.db）"),
    ("detach", "禁止 DETACH DATABASE：见 ATTACH 说明"),
    ("vacuum", "禁止 VACUUM：请通过维护命令而非业务 SQL 执行"),
    ("pragma", "禁止 PRAGMA：连接参数由 open_db 统一设置，业务层不得改写"),
];

/// 语句种类闸口：命中黑名单直接报错（S-2）。
///
/// 实现要点：先把注释与字符串字面量剥掉再匹配，否则 `SELECT '-- attach'` 这类
/// **合法**查询会被误杀。剥除对转义单引号（`''`）做正确处理。
fn guard_statement(sql: &str) -> Result<(), String> {
    let normalized = strip_sql_noise(sql).to_lowercase();
    for (keyword, reason) in FORBIDDEN_SQL {
        // 前后接非标识符字符才算词边界：避免 `attach_count` 这类列名被误判
        if contains_keyword(&normalized, keyword) {
            return Err(format!("SQL 被拒绝（{reason}）"));
        }
    }
    Ok(())
}

/// 判断 `text` 中是否出现独立的 `keyword`（前后不是标识符字符）。
fn contains_keyword(text: &str, keyword: &str) -> bool {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    let bytes = text.as_bytes();
    let mut from = 0usize;
    while let Some(at) = text[from..].find(keyword) {
        let start = from + at;
        let end = start + keyword.len();
        let before_ok = start == 0 || !is_ident(bytes[start - 1] as char);
        let after_ok = end >= bytes.len() || !is_ident(bytes[end] as char);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// 剥掉 SQL 注释与字符串字面量，避免在注释/字面量里「出现关键字」被误判。
fn strip_sql_noise(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let chars: Vec<char> = sql.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let current = chars[index];
        // 行注释：-- 到行尾
        if current == '-' && chars.get(index + 1) == Some(&'-') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        // 块注释：/* ... */
        if current == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                index += 1;
            }
            index += 2;
            continue;
        }
        // 字符串字面量：单引号，内部 '' 为转义
        if current == '\'' {
            index += 1;
            while index < chars.len() {
                if chars[index] == '\'' {
                    if chars.get(index + 1) == Some(&'\'') {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    break;
                }
                index += 1;
            }
            out.push(' ');
            continue;
        }
        // 双引号标识符 / 反引号 / 方括号：一并剥掉（少见但合法）
        if current == '"' || current == '`' || current == '[' {
            let closer = match current {
                '[' => ']',
                other => other,
            };
            index += 1;
            while index < chars.len() && chars[index] != closer {
                index += 1;
            }
            index += 1;
            out.push(' ');
            continue;
        }
        out.push(current);
        index += 1;
    }
    out
}

fn exec_result(
    conn: &mut Connection,
    sql: &str,
    params: &[Value],
) -> Result<ExecResult, String> {
    guard_statement(sql)?;
    let bound = bind_values(params)?;
    conn.execute(sql, rusqlite::params_from_iter(as_params(&bound)))
        .map_err(|error| format!("执行失败: {error}"))?;
    Ok(ExecResult {
        changes: conn.changes() as usize,
        last_insert_id: conn.last_insert_rowid(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    pub version: i64,
    pub description: String,
    pub sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[tauri::command]
pub async fn db_execute(
    app: AppHandle,
    sql: String,
    params: Vec<Value>,
) -> Result<ExecResult, String> {
    // 迁移窗口/迁移后拒绝写入（评审 P1，见 storage::STORE_STATE 注释）
    crate::storage::check_db_writes_allowed()?;
    // 建议 SQL 先参与绑定再进阻塞线程，避免把大参数数组搬进闭包后又搬回来
    run_blocking_db(move || with_db(&app, |conn| exec_result(conn, &sql, &params))).await
}

#[tauri::command]
pub async fn db_select(
    app: AppHandle,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    run_blocking_db(move || with_db(&app, |conn| rows_to_json(conn, &sql, &params))).await
}

/// 事务：按序执行多条语句，任何一条失败整体回滚。
#[tauri::command]
pub async fn db_transaction(
    app: AppHandle,
    statements: Vec<TxStatement>,
) -> Result<Vec<usize>, String> {
    crate::storage::check_db_writes_allowed()?;
    run_blocking_db(move || {
        with_db(&app, |conn| {
            let tx = conn
                .transaction()
                .map_err(|e| format!("开启事务失败: {e}"))?;
            let mut changes = Vec::with_capacity(statements.len());
            for statement in &statements {
                // S-2：事务路径同样过闸 —— 否则黑名单可以直接被绕过
                guard_statement(&statement.sql)?;
                let bound = bind_values(&statement.params)?;
                let affected = tx
                    .execute(
                        &statement.sql,
                        rusqlite::params_from_iter(as_params(&bound)),
                    )
                    .map_err(|error| format!("事务内执行失败（已回滚）: {error}"))?;
                changes.push(affected);
            }
            tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
            Ok(changes)
        })
    })
    .await
}

/// 版本化迁移：_migrations 表记录已应用版本，只跑未应用的，逐条独立事务。
/// 返回本次新应用的版本号列表。
#[tauri::command]
pub async fn db_migrate(app: AppHandle, migrations: Vec<Migration>) -> Result<Vec<i64>, String> {
    crate::storage::check_db_writes_allowed()?;
    run_blocking_db(move || {
        with_db(&app, |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS _migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                );",
            )
            .map_err(|e| format!("初始化迁移表失败: {e}"))?;

            let applied: Vec<i64> = {
                let mut statement = conn
                    .prepare("SELECT version FROM _migrations ORDER BY version")
                    .map_err(|e| e.to_string())?;
                let rows = statement
                    .query_map([], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(Result::ok).collect()
            };

            let mut pending: Vec<&Migration> = migrations
                .iter()
                .filter(|m| !applied.contains(&m.version))
                .collect();
            pending.sort_by_key(|m| m.version);

            let mut newly = Vec::new();
            for migration in pending {
                // S-2 补口（评审 R-1）：迁移是唯一没过闸的 SQL 入口，且
                // execute_batch 支持多语句比 execute 更宽。迁移 SQL 来自仓库内
                // TS 定义（可信），但「防误用」定位意味着手滑写进 ATTACH 也该拦。
                guard_statement(&migration.sql)?;
                let tx = conn
                    .transaction()
                    .map_err(|e| format!("开启事务失败: {e}"))?;
                tx.execute_batch(&migration.sql).map_err(|e| {
                    format!(
                        "迁移 v{}「{}」失败（已回滚）: {e}",
                        migration.version, migration.description
                    )
                })?;
                let now = logging::now_local();
                tx.execute(
                    "INSERT INTO _migrations(version, description, applied_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        migration.version,
                        migration.description,
                        format!("{} {}", now.date, now.clock)
                    ],
                )
                .map_err(|e| format!("记录迁移失败: {e}"))?;
                tx.commit()
                    .map_err(|e| format!("提交迁移失败: {e}"))?;
                newly.push(migration.version);
            }
            Ok(newly)
        })
    })
    .await
}