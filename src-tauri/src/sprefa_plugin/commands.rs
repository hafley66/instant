// Sprefa plugin Tauri commands.
//
// Each command talks to the sprefa daemon over its RPC socket in
// /tmp/sprefa-daemon.sock, or via the sprefa Engine directly (linked as a
// library). Register these in lib.rs via generate_handler![].
//
// Example commands:
//
//   #[tauri::command]
//   fn schema() -> Result<serde_json::Value, String> { ... }
//
//   #[tauri::command]
//   fn query_sql(sql: String, params: Vec<serde_json::Value>) -> Result<Vec<serde_json::Value>, String> { ... }
//
// Stub implementations below; replace when the sprefa daemon is integrated.