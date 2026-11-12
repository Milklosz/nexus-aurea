use serde::{Deserialize, Serialize};

/// Flaga awaryjnego, okienkowego startu obsługiwana przez setup Tauri w `lib.rs`.
pub const SAFE_MODE_FLAG: &str = "--windowed";

/// Nazwa jedynej wartości w gałęzi Run bieżącego użytkownika.
pub fn run_value_name() -> &'static str {
    "VELORA"
}

/// Jedyna dozwolona gałąź rejestru: Run bieżącego użytkownika (HKCU).
/// Nie dotykamy gałęzi globalnych, wartości powłoki logowania ani folderu Startup.
pub fn registry_run_key() -> &'static str {
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub windows: bool,
    pub supported: bool,
    pub enabled: bool,
    pub windowed: bool,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupMode {
    pub windowed: bool,
    pub autostart_enabled: bool,
}

impl AutostartStatus {
    fn unsupported() -> Self {
        Self {
            windows: false,
            supported: false,
            enabled: false,
            windowed: false,
            last_error: None,
        }
    }
}

/// Czysty helper: wykrywa dokładną flagę --windowed w argumentach procesu.
pub fn windowed_flag_present(args: &[String]) -> bool {
    args.iter().any(|arg| arg == SAFE_MODE_FLAG)
}

/**
 * Buduje wartość wpisu Run: "<ścieżka do exe>" z opcjonalnym " --windowed".
 * Usuwa znaki, które mogłyby wstrzyknąć cudzysłów lub nową linię do polecenia.
 */
pub fn autostart_command_value(exe: &str, windowed: bool) -> String {
    let clean: String = exe
        .chars()
        .filter(|c| *c != '"' && *c != '\n' && *c != '\r')
        .collect();
    let quoted = format!("\"{}\"", clean);
    if windowed {
        format!("{} {}", quoted, SAFE_MODE_FLAG)
    } else {
        quoted
    }
}

/// Stała, jawna lista argumentów dla `reg.exe add` (bez powłoki, bez cmd /c).
pub fn registry_add_arguments(value: &str) -> Vec<String> {
    vec![
        "add".to_string(),
        registry_run_key().to_string(),
        "/v".to_string(),
        run_value_name().to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        value.to_string(),
        "/f".to_string(),
    ]
}

/// Stała, jawna lista argumentów dla `reg.exe delete` — usuwa dokładnie VELORA.
pub fn registry_delete_arguments() -> Vec<String> {
    vec![
        "delete".to_string(),
        registry_run_key().to_string(),
        "/v".to_string(),
        run_value_name().to_string(),
        "/f".to_string(),
    ]
}

/// Stała, jawna lista argumentów dla `reg.exe query` (tylko odczyt).
pub fn registry_query_arguments() -> Vec<String> {
    vec![
        "query".to_string(),
        registry_run_key().to_string(),
        "/v".to_string(),
        run_value_name().to_string(),
    ]
}

#[tauri::command]
pub fn get_autostart_status() -> AutostartStatus {
    #[cfg(target_os = "windows")]
    {
        windows::status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        AutostartStatus::unsupported()
    }
}

#[tauri::command]
pub fn set_autostart_enabled(enabled: bool, windowed: bool) -> Result<AutostartStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows::apply(enabled, windowed)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (enabled, windowed);
        Err("Autostart jest dostępny tylko w natywnej aplikacji Windows.".to_string())
    }
}

#[tauri::command]
pub fn get_startup_mode() -> StartupMode {
    let args: Vec<String> = std::env::args().collect();
    StartupMode {
        windowed: windowed_flag_present(&args),
        autostart_enabled: current_autostart_enabled(),
    }
}

fn current_autostart_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows::is_enabled()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

// Cała implementacja systemowa istnieje wyłącznie na Windows. Na macOS Linuxie
// żaden z poniższych importów ani wywołań nie jest kompilowany.
#[cfg(target_os = "windows")]
mod windows {
    use super::{
        autostart_command_value, registry_add_arguments, registry_delete_arguments,
        registry_query_arguments, run_value_name, AutostartStatus, SAFE_MODE_FLAG,
    };
    use std::process::Command;

    fn run_reg(arguments: Vec<String>) -> std::io::Result<std::process::Output> {
        Command::new("reg.exe").args(&arguments).output()
    }

    fn value_line(output: &std::process::Output) -> Option<String> {
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .lines()
            .find(|line| line.contains(run_value_name()))
            .map(|line| line.to_string())
    }

    pub fn is_enabled() -> bool {
        match run_reg(registry_query_arguments()) {
            Ok(output) => value_line(&output).is_some(),
            Err(_) => false,
        }
    }

    pub fn status() -> AutostartStatus {
        match run_reg(registry_query_arguments()) {
            Ok(output) => {
                if let Some(line) = value_line(&output) {
                    AutostartStatus {
                        windows: true,
                        supported: true,
                        enabled: true,
                        windowed: line.contains(SAFE_MODE_FLAG),
                        last_error: None,
                    }
                } else {
                    // Brak wartości VELORA (reg.exe zwraca kod niezerowy) to
                    // poprawny, wyłączony stan — nie błąd.
                    AutostartStatus {
                        windows: true,
                        supported: true,
                        enabled: false,
                        windowed: false,
                        last_error: None,
                    }
                }
            }
            Err(cause) => AutostartStatus {
                windows: true,
                supported: true,
                enabled: false,
                windowed: false,
                last_error: Some(format!("Nie udało się odczytać wpisu autostartu: {}", cause)),
            },
        }
    }

    /// Jedyna funkcja zapisująca do systemu. Wywoływana wyłącznie w wyniku
    /// jawnego `set_autostart_enabled` (kliknięcia przełącznika opt-in).
    pub fn apply(enabled: bool, windowed: bool) -> Result<AutostartStatus, String> {
        let arguments = if enabled {
            let exe = std::env::current_exe()
                .map_err(|cause| format!("Nie udało się odczytać ścieżki aplikacji VELORA: {}", cause))?;
            let value = autostart_command_value(&exe.to_string_lossy(), windowed);
            registry_add_arguments(&value)
        } else {
            registry_delete_arguments()
        };

        let output = run_reg(arguments)
            .map_err(|cause| format!("Nie udało się uruchomić reg.exe: {}", cause))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            let detail = if detail.is_empty() {
                "reg.exe zwrócił błąd"
            } else {
                detail
            };
            return Err(if enabled {
                format!("Nie udało się włączyć autostartu VELORA: {}", detail)
            } else {
                format!("Nie udało się wyłączyć autostartu VELORA: {}", detail)
            });
        }

        // Nigdy nie zgłaszamy sukcesu bez potwierdzenia rzeczywistego stanu.
        let current = status();
        if current.enabled != enabled {
            return Err(if enabled {
                "Wpis autostartu VELORA nie został potwierdzony po zapisie.".to_string()
            } else {
                "Wpis autostartu VELORA nadal istnieje po próbie usunięcia.".to_string()
            });
        }
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windowed_flag_is_detected_only_when_exact() {
        assert!(windowed_flag_present(&[
            "velora.exe".to_string(),
            SAFE_MODE_FLAG.to_string()
        ]));
        assert!(windowed_flag_present(&[SAFE_MODE_FLAG.to_string()]));
        assert!(!windowed_flag_present(&["velora.exe".to_string()]));
        let empty: Vec<String> = Vec::new();
        assert!(!windowed_flag_present(&empty));
        assert!(!windowed_flag_present(&[
            "--windowed-extra".to_string(),
            "--fullscreen".to_string()
        ]));
    }

    #[test]
    fn command_value_is_quoted_and_flag_is_optional() {
        let exe = r"C:\Program Files\VELORA\velora.exe";
        assert_eq!(autostart_command_value(exe, false), format!("\"{}\"", exe));
        assert_eq!(
            autostart_command_value(exe, true),
            format!("\"{}\" {}", exe, SAFE_MODE_FLAG)
        );
    }

    #[test]
    fn command_value_rejects_injected_quotes_and_newlines() {
        let injected = "C:\\VELORA\\velora.exe\" --windowed\n\r extra";
        let value = autostart_command_value(injected, true);
        assert!(!value.contains('\n'));
        assert!(!value.contains('\r'));
        assert_eq!(value.matches('"').count(), 2);
        assert!(value.starts_with('"'));
        assert!(value.ends_with(SAFE_MODE_FLAG));
    }

    #[test]
    fn add_arguments_use_a_fixed_hkcu_only_layout() {
        let value = autostart_command_value(r"C:\VELORA\velora.exe", true);
        let args = registry_add_arguments(&value);
        assert_eq!(args.len(), 9);
        assert_eq!(args[0], "add");
        assert_eq!(args[1], registry_run_key());
        assert_eq!(args[2], "/v");
        assert_eq!(args[3], run_value_name());
        assert_eq!(args[4], "/t");
        assert_eq!(args[5], "REG_SZ");
        assert_eq!(args[6], "/d");
        assert_eq!(args[7], value);
        assert_eq!(args[8], "/f");
    }

    #[test]
    fn delete_arguments_remove_exactly_the_velora_value() {
        let args = registry_delete_arguments();
        assert_eq!(args.len(), 5);
        assert_eq!(args[0], "delete");
        assert_eq!(args[1], registry_run_key());
        assert_eq!(args[2], "/v");
        assert_eq!(args[3], run_value_name());
        assert_eq!(args[4], "/f");
    }

    #[test]
    fn query_arguments_are_read_only_and_fixed() {
        let args = registry_query_arguments();
        assert_eq!(args.len(), 4);
        assert_eq!(args[0], "query");
        assert_eq!(args[1], registry_run_key());
        assert_eq!(args[2], "/v");
        assert_eq!(args[3], run_value_name());
    }

    #[test]
    fn run_value_name_is_stable() {
        assert_eq!(run_value_name(), "VELORA");
    }

    fn assert_only_hkcu_without_shell_or_cmd(args: &[String]) {
        let joined = args.join(" ");
        assert!(joined.contains("HKCU"));
        let upper = joined.to_uppercase();
        assert!(!upper.contains("HKLM"));
        assert!(!upper.contains("WINLOGON"));
        assert!(!upper.contains("SHELL"));
        assert!(!upper.contains("CMD"));
        assert!(!args.iter().any(|a| a == "/c"));
    }

    #[test]
    fn no_hklm_winlogon_shell_or_cmd_appears_anywhere() {
        let add = registry_add_arguments(&autostart_command_value(r"C:\VELORA\velora.exe", true));
        let delete = registry_delete_arguments();
        let query = registry_query_arguments();
        for args in [&add, &delete, &query] {
            assert_only_hkcu_without_shell_or_cmd(args);
        }
        assert_only_hkcu_without_shell_or_cmd(&[registry_run_key().to_string()]);
    }
}
