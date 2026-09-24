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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
    // WAL 需要目录可写；失败时退回默认 journal 模式而不是让整个应用起不来
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    Ok(Db(Mutex::new(conn)))
}

/// WAL 检查点：把 -wal 中未落盘的数据合并回主 .db 文件。
/// 迁移存储目录前必须调用，否则复制走的主文件可能缺最近事务数据。
/// 返回是否成功（非 WAL 模式下本就可能失败，仅报告、不致命）。
pub fn checkpoint(app: &AppHandle) -> bool {
    let Some(db) = app.try_state::<Db>() else {
        return false;
    };
    let conn = db.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .is_ok()
}

fn with_db<R, F: FnOnce(&mut Connection) -> Result<R, String>>(
    app: &AppHandle,
    f: F,
) -> Result<R, String> {
    let db = app.state::<Db>();
    // 中毒锁恢复：这里串行访问且不会 panic 在持锁中段，unwrap_or_else 更稳
    let mut conn = db
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut conn)
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
                Value::from(int as f64)
            }
        }
        ValueRef::Real(real) => Value::from(real),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(_) => Value::String("[blob]".to_string()),
    }
}

fn rows_to_json(
    conn: &mut Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Map<String, Value>>, String> {
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

fn exec_result(
    conn: &mut Connection,
    sql: &str,
    params: &[Value],
) -> Result<ExecResult, String> {
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
pub fn db_execute(app: AppHandle, sql: String, params: Vec<Value>) -> Result<ExecResult, String> {
    with_db(&app, |conn| exec_result(conn, &sql, &params))
}

#[tauri::command]
pub fn db_select(
    app: AppHandle,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    with_db(&app, |conn| rows_to_json(conn, &sql, &params))
}

/// 事务：按序执行多条语句，任何一条失败整体回滚。
#[tauri::command]
pub fn db_transaction(app: AppHandle, statements: Vec<TxStatement>) -> Result<Vec<usize>, String> {
    with_db(&app, |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        let mut changes = Vec::with_capacity(statements.len());
        for statement in &statements {
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
}

/// 版本化迁移：_migrations 表记录已应用版本，只跑未应用的，逐条独立事务。
/// 返回本次新应用的版本号列表。
#[tauri::command]
pub fn db_migrate(app: AppHandle, migrations: Vec<Migration>) -> Result<Vec<i64>, String> {
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
}