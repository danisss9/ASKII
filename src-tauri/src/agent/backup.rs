use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMeta {
    original_path: String,
    existed_before: bool,
    moved_to_path: Option<String>,
}

pub fn backups_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("dev.askii.desktop").join("backups")
}

pub fn create_backup(path: &Path, moved_to_path: Option<&Path>) -> Result<String, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create backup dir: {e}"))?;

    let backup_id = Uuid::new_v4().to_string();
    let existed_before = path.exists();

    if existed_before {
        let data_path = dir.join(format!("{backup_id}.bak"));
        fs::copy(path, &data_path).map_err(|e| format!("Failed to copy backup snapshot: {e}"))?;
    }

    let meta = BackupMeta {
        original_path: path.to_string_lossy().to_string(),
        existed_before,
        moved_to_path: moved_to_path.map(|p| p.to_string_lossy().to_string()),
    };
    let meta_path = dir.join(format!("{backup_id}.meta.json"));
    let json =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("Backup meta error: {e}"))?;
    fs::write(&meta_path, json).map_err(|e| format!("Failed to write backup metadata: {e}"))?;

    Ok(backup_id)
}

pub fn restore_backup(backup_id: &str) -> Result<String, String> {
    if backup_id.contains("..") || backup_id.contains('/') || backup_id.contains('\\') {
        return Err("Invalid backup ID.".to_string());
    }
    let dir = backups_dir();
    let meta_path = dir.join(format!("{backup_id}.meta.json"));
    let raw = fs::read_to_string(&meta_path)
        .map_err(|_| format!("Backup \"{backup_id}\" was not found."))?;
    let meta: BackupMeta =
        serde_json::from_str(&raw).map_err(|e| format!("Corrupt backup metadata: {e}"))?;

    let orig = PathBuf::from(&meta.original_path);

    if let Some(ref moved) = meta.moved_to_path {
        let moved_path = PathBuf::from(moved);
        if moved_path.exists() {
            let _ = fs::remove_file(&moved_path);
        }
    }

    if meta.existed_before {
        let data_path = dir.join(format!("{backup_id}.bak"));
        if let Some(parent) = orig.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(&data_path, &orig).map_err(|e| format!("Failed to restore backup file: {e}"))?;
        Ok(format!("Restored {}", orig.display()))
    } else {
        if orig.exists() {
            fs::remove_file(&orig).map_err(|e| format!("Failed to remove created file: {e}"))?;
        }
        Ok(format!("Removed newly created file {}", orig.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_restores_file_backup_and_new_file_rollback() {
        let tmp = std::env::temp_dir().join(format!("askii_bak_test_{}.txt", Uuid::new_v4()));
        fs::write(&tmp, "original content").unwrap();

        let id = create_backup(&tmp, None).unwrap();
        fs::write(&tmp, "modified content").unwrap();
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "modified content");

        restore_backup(&id).unwrap();
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "original content");
        let _ = fs::remove_file(&tmp);

        // Also test rolling back a brand-new file
        let new_file = std::env::temp_dir().join(format!("askii_new_test_{}.txt", Uuid::new_v4()));
        let id2 = create_backup(&new_file, None).unwrap();
        fs::write(&new_file, "created").unwrap();
        assert!(new_file.exists());
        restore_backup(&id2).unwrap();
        assert!(!new_file.exists());
    }
}
