use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTurn {
    pub question: String,
    pub answer: String,
    pub timestamp: String,
    pub provider_label: String,
    pub model: String,
    #[serde(default)]
    pub context_labels: Vec<String>,
    #[serde(default)]
    pub tool_actions_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSlip {
    pub id: String,
    pub slip_number: u32,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub turns: Vec<StoredTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlipSummary {
    pub id: String,
    pub slip_number: u32,
    pub title: String,
    pub preview: String,
    pub provider: String,
    pub model: String,
    pub turn_count: usize,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: i64,
    pub content: String,
    pub created_at: i64,
}

pub struct Storage {
    conn: Connection,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn db_file_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("dev.askii.desktop").join("askii.db")
}

impl Storage {
    pub fn open_default() -> Result<Self, String> {
        let path = db_file_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create storage directory: {e}"))?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open SQLite database at {}: {e}", path.display()))?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory SQLite: {e}"))?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS slips (
                    id TEXT PRIMARY KEY,
                    slip_number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS turns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slip_id TEXT NOT NULL,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    provider_label TEXT NOT NULL,
                    model TEXT NOT NULL,
                    context_labels_json TEXT NOT NULL DEFAULT '[]',
                    tool_actions_json TEXT NOT NULL DEFAULT '[]',
                    FOREIGN KEY (slip_id) REFERENCES slips(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_turns_slip ON turns(slip_id);
                CREATE INDEX IF NOT EXISTS idx_slips_updated ON slips(updated_at DESC);
                ",
            )
            .map_err(|e| format!("SQLite schema init failed: {e}"))
    }

    pub fn save_slip(&self, slip: &StoredSlip) -> Result<(), String> {
        let ts = now_unix();
        let created = if slip.created_at > 0 {
            slip.created_at
        } else {
            ts
        };
        self.conn
            .execute(
                "INSERT INTO slips (id, slip_number, title, provider, model, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title,
                   provider = excluded.provider,
                   model = excluded.model,
                   updated_at = excluded.updated_at",
                params![
                    slip.id,
                    slip.slip_number,
                    slip.title,
                    slip.provider,
                    slip.model,
                    created,
                    ts
                ],
            )
            .map_err(|e| format!("Failed to save slip: {e}"))?;

        self.conn
            .execute("DELETE FROM turns WHERE slip_id = ?1", params![slip.id])
            .map_err(|e| format!("Failed to refresh slip turns: {e}"))?;

        for turn in &slip.turns {
            let ctx_json = serde_json::to_string(&turn.context_labels).unwrap_or_else(|_| "[]".to_string());
            let tools_json = if turn.tool_actions_json.trim().is_empty() {
                "[]".to_string()
            } else {
                turn.tool_actions_json.clone()
            };
            self.conn
                .execute(
                    "INSERT INTO turns (slip_id, question, answer, timestamp, provider_label, model, context_labels_json, tool_actions_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        slip.id,
                        turn.question,
                        turn.answer,
                        turn.timestamp,
                        turn.provider_label,
                        turn.model,
                        ctx_json,
                        tools_json
                    ],
                )
                .map_err(|e| format!("Failed to insert turn: {e}"))?;
        }
        Ok(())
    }

    pub fn list_slips(&self, query: Option<&str>, limit: usize) -> Result<Vec<SlipSummary>, String> {
        let q = query.unwrap_or("").trim().to_ascii_lowercase();
        let cap = limit.clamp(1, 100) as i64;

        let mut stmt = if q.is_empty() {
            self.conn
                .prepare(
                    "SELECT s.id, s.slip_number, s.title, s.provider, s.model, s.updated_at,
                            (SELECT COUNT(*) FROM turns t WHERE t.slip_id = s.id) as cnt,
                            COALESCE((SELECT t.answer FROM turns t WHERE t.slip_id = s.id ORDER BY t.id DESC LIMIT 1), '') as preview
                     FROM slips s
                     ORDER BY s.updated_at DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("Query prepare failed: {e}"))?
        } else {
            self.conn
                .prepare(
                    "SELECT DISTINCT s.id, s.slip_number, s.title, s.provider, s.model, s.updated_at,
                            (SELECT COUNT(*) FROM turns t WHERE t.slip_id = s.id) as cnt,
                            COALESCE((SELECT t.answer FROM turns t WHERE t.slip_id = s.id ORDER BY t.id DESC LIMIT 1), '') as preview
                     FROM slips s
                     LEFT JOIN turns t ON t.slip_id = s.id
                     WHERE LOWER(s.title) LIKE ?1 OR LOWER(t.question) LIKE ?1 OR LOWER(t.answer) LIKE ?1
                     ORDER BY s.updated_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("Search prepare failed: {e}"))?
        };

        let mapper = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SlipSummary> {
            let preview_raw: String = row.get(7)?;
            let preview: String = preview_raw
                .replace('\n', " ")
                .chars()
                .take(140)
                .collect();
            Ok(SlipSummary {
                id: row.get(0)?,
                slip_number: row.get(1)?,
                title: row.get(2)?,
                provider: row.get(3)?,
                model: row.get(4)?,
                updated_at: row.get(5)?,
                turn_count: row.get::<_, i64>(6)? as usize,
                preview,
            })
        };

        let rows = if q.is_empty() {
            stmt.query_map(params![cap], mapper)
                .map_err(|e| format!("Query failed: {e}"))?
                .flatten()
                .collect()
        } else {
            let pattern = format!("%{q}%");
            stmt.query_map(params![pattern, cap], mapper)
                .map_err(|e| format!("Search failed: {e}"))?
                .flatten()
                .collect()
        };

        Ok(rows)
    }

    pub fn get_slip(&self, id: &str) -> Result<Option<StoredSlip>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, slip_number, title, provider, model, created_at, updated_at
                 FROM slips WHERE id = ?1",
            )
            .map_err(|e| format!("Prepare failed: {e}"))?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| format!("Fetch slip failed: {e}"))?;

        let Some(Ok((id, slip_number, title, provider, model, created_at, updated_at))) = rows.next() else {
            return Ok(None);
        };

        let mut tstmt = self
            .conn
            .prepare(
                "SELECT question, answer, timestamp, provider_label, model, context_labels_json, tool_actions_json
                 FROM turns WHERE slip_id = ?1 ORDER BY id ASC",
            )
            .map_err(|e| format!("Prepare turns failed: {e}"))?;

        let turns: Vec<StoredTurn> = tstmt
            .query_map(params![id], |row| {
                let ctx_str: String = row.get(5)?;
                let context_labels: Vec<String> =
                    serde_json::from_str(&ctx_str).unwrap_or_default();
                Ok(StoredTurn {
                    question: row.get(0)?,
                    answer: row.get(1)?,
                    timestamp: row.get(2)?,
                    provider_label: row.get(3)?,
                    model: row.get(4)?,
                    context_labels,
                    tool_actions_json: row.get(6)?,
                })
            })
            .map_err(|e| format!("Fetch turns failed: {e}"))?
            .flatten()
            .collect();

        Ok(Some(StoredSlip {
            id,
            slip_number,
            title,
            provider,
            model,
            created_at,
            updated_at,
            turns,
        }))
    }

    pub fn delete_slip(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM turns WHERE slip_id = ?1", params![id])
            .map_err(|e| format!("Delete turns failed: {e}"))?;
        self.conn
            .execute("DELETE FROM slips WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete slip failed: {e}"))?;
        Ok(())
    }

    pub fn add_memory(&self, content: &str) -> Result<MemoryEntry, String> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Err("Memory text cannot be empty.".to_string());
        }
        let ts = now_unix();
        self.conn
            .execute(
                "INSERT INTO memories (content, created_at) VALUES (?1, ?2)",
                params![trimmed, ts],
            )
            .map_err(|e| format!("Failed to add memory: {e}"))?;
        let id = self.conn.last_insert_rowid();
        Ok(MemoryEntry {
            id,
            content: trimmed.to_string(),
            created_at: ts,
        })
    }

    pub fn list_memories(&self) -> Result<Vec<MemoryEntry>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, content, created_at FROM memories ORDER BY id DESC LIMIT 60")
            .map_err(|e| format!("List memories failed: {e}"))?;
        let list = stmt
            .query_map([], |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })
            .map_err(|e| format!("Query memories failed: {e}"))?
            .flatten()
            .collect();
        Ok(list)
    }

    pub fn delete_memory(&self, id: i64) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete memory failed: {e}"))?;
        Ok(())
    }

    pub fn format_memories_block(&self) -> Option<String> {
        let items = self.list_memories().ok()?;
        if items.is_empty() {
            return None;
        }
        let bullets: Vec<String> = items.iter().map(|m| format!("- {}", m.content)).collect();
        Some(format!(
            "User's saved personal preferences & memory (respect these when helpful):\n{}",
            bullets.join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_searches_reloads_and_deletes_slips_and_memories() {
        let db = Storage::open_in_memory().unwrap();
        let slip = StoredSlip {
            id: "slip-1".to_string(),
            slip_number: 1,
            title: "Rust Tauri Guide".to_string(),
            provider: "OpenAI".to_string(),
            model: "gpt-4o".to_string(),
            created_at: 100,
            updated_at: 100,
            turns: vec![StoredTurn {
                question: "How do Tauri channels work?".to_string(),
                answer: "Channels stream typed events from Rust to Angular.".to_string(),
                timestamp: "12:00".to_string(),
                provider_label: "OpenAI".to_string(),
                model: "gpt-4o".to_string(),
                context_labels: vec!["Window · Code".to_string()],
                tool_actions_json: "[]".to_string(),
            }],
        };

        db.save_slip(&slip).unwrap();
        let found = db.list_slips(Some("channels"), 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "slip-1");

        let loaded = db.get_slip("slip-1").unwrap().unwrap();
        assert_eq!(loaded.turns.len(), 1);
        assert_eq!(loaded.turns[0].context_labels[0], "Window · Code");

        db.delete_slip("slip-1").unwrap();
        assert!(db.get_slip("slip-1").unwrap().is_none());

        let mem = db.add_memory("Prefer PowerShell 7 syntax").unwrap();
        assert!(db.format_memories_block().unwrap().contains("PowerShell 7"));
        db.delete_memory(mem.id).unwrap();
        assert!(db.format_memories_block().is_none());
    }
}
