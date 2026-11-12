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

// ===== Diagnostyka i odzyskiwanie autostartu (wyłącznie do odczytu) =====
//
// Poniższe funkcje są czyste (bez I/O, bez reg.exe) i dlatego testowalne na
// macOS. Nowe komendy Tauri NIGDY nie zapisują do systemu — raportują stan
// istniejącego wpisu, a ewentualne odświeżenie pozostawiają użytkownikowi
// przez istniejący przełącznik opt-in (set_autostart_enabled).

/// Rodzaj problemu wykrytego w istniejącym wpisie autostartu.
/// `QueryFailed(String)` niesie surową diagnozę WYŁĄCZNIE do celów
/// diagnostycznych — `user_message()` nigdy jej nie ujawnia.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutostartIssue {
    MissingValue,
    MalformedCommand,
    ExecutablePathInvalid,
    ExecutableMissing,
    WrongExecutable,
    UnexpectedArguments,
    QueryFailed(String),
}

impl AutostartIssue {
    /// Stabilny kod problemu (camelCase) — bez ścieżek i detali systemowych.
    pub fn code(&self) -> &'static str {
        match self {
            AutostartIssue::MissingValue => "missingValue",
            AutostartIssue::MalformedCommand => "malformedCommand",
            AutostartIssue::ExecutablePathInvalid => "executablePathInvalid",
            AutostartIssue::ExecutableMissing => "executableMissing",
            AutostartIssue::WrongExecutable => "wrongExecutable",
            AutostartIssue::UnexpectedArguments => "unexpectedArguments",
            AutostartIssue::QueryFailed(_) => "queryFailed",
        }
    }

    /// Czytelny, bezpieczny komunikat po polsku. Nigdy nie zawiera surowych
    /// ścieżek, komunikatów systemu ani ładunku `QueryFailed`.
    pub fn user_message(&self) -> String {
        match self {
            AutostartIssue::MissingValue => {
                "Brak wpisu autostartu VELORA. Włącz autostart, jeśli chcesz uruchamiać VELORA po zalogowaniu.".to_string()
            }
            AutostartIssue::MalformedCommand => {
                "Wpis autostartu VELORA ma nieprawidłową postać. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string()
            }
            AutostartIssue::ExecutablePathInvalid => {
                "Wpis autostartu VELORA zawiera nieprawidłową ścieżkę do aplikacji. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string()
            }
            AutostartIssue::ExecutableMissing => {
                "Nie znaleziono pliku aplikacji VELORA wskazywanego przez wpis. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string()
            }
            AutostartIssue::WrongExecutable => {
                "Wpis autostartu wskazuje na inną wersję VELORA. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string()
            }
            AutostartIssue::UnexpectedArguments => {
                "Wpis autostartu VELORA zawiera nieoczekiwane parametry. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string()
            }
            AutostartIssue::QueryFailed(_) => {
                "Nie udało się odczytać wpisu autostartu VELORA. Spróbuj ponownie później.".to_string()
            }
        }
    }
}

/// Waliduje ścieżkę do pliku wykonywalnego zapisaną we wpisie.
/// Czysta, deterministyczna, bez dostępu do dysku.
pub fn validate_executable_path(path: &str) -> Result<(), AutostartIssue> {
    if path.is_empty() || path.len() > 1024 {
        return Err(AutostartIssue::ExecutablePathInvalid);
    }
    for c in path.chars() {
        if c == '"' || c.is_control() {
            return Err(AutostartIssue::ExecutablePathInvalid);
        }
        if matches!(c, '&' | '|' | '^' | '%' | '!') {
            return Err(AutostartIssue::ExecutablePathInvalid);
        }
    }
    if path.contains("..") {
        return Err(AutostartIssue::ExecutablePathInvalid);
    }
    let bytes = path.as_bytes();
    let absolute = (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || (bytes.len() >= 2 && bytes[0] == b'\\' && bytes[1] == b'\\');
    if !absolute {
        return Err(AutostartIssue::ExecutablePathInvalid);
    }
    if !path.to_ascii_lowercase().ends_with(".exe") {
        return Err(AutostartIssue::ExecutablePathInvalid);
    }
    Ok(())
}

/// Parsuje wartość REG_SZ wpisu Run: opcjonalny cudzysłów wokół ścieżki,
/// opcjonalna pojedyncza flaga `--windowed` na końcu. Zwraca (exe, windowed).
/// Wykrywa „błędny wpis": wstrzyknięte cudzysłowy/nowe linie, dodatkowe
/// argumenty, nieujęte w cudzysłów ścieżki ze spacjami, wielokrotne flagi.
pub fn parse_command_value(value: &str) -> Result<(String, bool), AutostartIssue> {
    if value.chars().any(|c| c.is_control()) {
        return Err(AutostartIssue::MalformedCommand);
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AutostartIssue::MalformedCommand);
    }

    let (exe, rest) = if trimmed.starts_with('"') {
        let after_open = &trimmed[1..];
        let closing = match after_open.find('"') {
            Some(index) => index,
            None => return Err(AutostartIssue::MalformedCommand),
        };
        let exe = after_open[..closing].to_string();
        let rest = after_open[closing + 1..].to_string();
        if rest.contains('"') || exe.is_empty() {
            return Err(AutostartIssue::MalformedCommand);
        }
        (exe, rest)
    } else {
        if trimmed.contains('"') {
            return Err(AutostartIssue::MalformedCommand);
        }
        let mut parts = trimmed.splitn(2, |c: char| c.is_whitespace());
        let exe = parts.next().unwrap_or("").to_string();
        let rest = parts.next().unwrap_or("").trim().to_string();
        if exe.is_empty() {
            return Err(AutostartIssue::MalformedCommand);
        }
        // Bez cudzysłowu dopuszczamy wyłącznie pustą resztę albo pojedynczą
        // flagę — wszystko inne to spacje w ścieżce lub dodatkowe argumenty.
        if !rest.is_empty() && rest != SAFE_MODE_FLAG {
            return Err(AutostartIssue::MalformedCommand);
        }
        (exe, rest)
    };

    let rest = rest.trim();
    let windowed = if rest.is_empty() {
        false
    } else if rest == SAFE_MODE_FLAG {
        true
    } else {
        return Err(AutostartIssue::UnexpectedArguments);
    };
    Ok((exe, windowed))
}

fn paths_equal(left: &str, right: &str) -> bool {
    fn normalize(path: &str) -> String {
        let mut normalized = path.trim().to_ascii_lowercase().replace('/', "\\");
        while normalized.ends_with('\\') {
            normalized.pop();
        }
        normalized
    }
    normalize(left) == normalize(right)
}

/// Czysta, deterministyczna analiza wpisu (bez I/O). Porównuje ścieżkę z wpisu
/// z bieżącym plikiem wykonywalnym — wykrywa wpis nieaktualny po aktualizacji
/// lub przeniesieniu VELORA. Nie sprawdza istnienia pliku (wymagałoby to I/O).
pub fn detect_issues(value: Option<&str>, current_exe: Option<&str>) -> Vec<AutostartIssue> {
    let raw = match value {
        Some(v) => v,
        None => return vec![AutostartIssue::MissingValue],
    };
    let (exe, _windowed) = match parse_command_value(raw) {
        Ok(parsed) => parsed,
        Err(issue) => return vec![issue],
    };
    let mut issues = Vec::new();
    if let Err(issue) = validate_executable_path(&exe) {
        issues.push(issue);
    }
    if let Some(current) = current_exe {
        if !paths_equal(&exe, current) {
            issues.push(AutostartIssue::WrongExecutable);
        }
    }
    issues
}

pub fn is_healthy(issues: &[AutostartIssue]) -> bool {
    issues.is_empty()
}

/// Czysta, polska wskazówka dla użytkownika. NIGDY nie naprawia wpisu
/// automatycznie — zaleca wyłączenie i ponowne włączenie przełącznika.
pub fn recovery_message(issues: &[AutostartIssue]) -> String {
    if issues.is_empty() {
        return "Wpis autostartu VELORA jest poprawny. Nie są potrzebne żadne działania.".to_string();
    }
    if issues.iter().any(|i| matches!(i, AutostartIssue::WrongExecutable)) {
        return "Wpis autostartu wskazuje na inną wersję VELORA. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string();
    }
    if issues
        .iter()
        .any(|i| matches!(i, AutostartIssue::ExecutablePathInvalid | AutostartIssue::ExecutableMissing))
    {
        return "Wpis autostartu VELORA zawiera nieprawidłową ścieżkę do aplikacji. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string();
    }
    if issues
        .iter()
        .any(|i| matches!(i, AutostartIssue::MalformedCommand | AutostartIssue::UnexpectedArguments))
    {
        return "Wpis autostartu VELORA jest uszkodzony. Wyłącz i włącz autostart ponownie, aby go odświeżyć.".to_string();
    }
    if issues.iter().any(|i| matches!(i, AutostartIssue::MissingValue)) {
        return "Autostart VELORA jest wyłączony. Włącz go przełącznikiem, jeśli chcesz uruchamiać VELORA po zalogowaniu.".to_string();
    }
    if issues.iter().any(|i| matches!(i, AutostartIssue::QueryFailed(_))) {
        return "Nie udało się sprawdzić wpisu autostartu VELORA. Spróbuj ponownie później.".to_string();
    }
    "Wpis autostartu VELORA wymaga odświeżenia. Wyłącz i włącz autostart ponownie.".to_string()
}

/// Czysty znacznik czasu (sekundy od epoki) bez zależności od platformy.
pub fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

/// Mapuje problemy wyłącznie na ich kody — nigdy nie ujawnia surowych danych.
pub fn issue_codes(issues: &[AutostartIssue]) -> Vec<String> {
    issues.iter().map(|issue| issue.code().to_string()).collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartDiagnostics {
    pub windows: bool,
    pub supported: bool,
    pub healthy: bool,
    pub path_valid: bool,
    pub command_valid: bool,
    pub issues: Vec<String>,
    pub last_error: Option<String>,
    pub checked_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartRecoveryReport {
    pub windows: bool,
    pub supported: bool,
    pub stale: bool,
    pub recommended_action: String,
    pub issues: Vec<String>,
    pub safe_mode: bool,
}

/// TYLKO DO ODCZYTU: odczytuje bieżący wpis `VELORA` (reg.exe query), analizuje
/// go czystymi helperami i zwraca kody problemów. Nigdy nie wywołuje
/// reg.exe add/delete — jedynym zapisem pozostaje set_autostart_enabled.
#[tauri::command]
pub fn get_autostart_diagnostics() -> AutostartDiagnostics {
    #[cfg(target_os = "windows")]
    {
        let value = windows::read_command_value();
        let current_exe = std::env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        let issues = detect_issues(value.as_deref(), current_exe.as_deref());
        let healthy = is_healthy(&issues);
        let path_valid = !issues.iter().any(|issue| {
            matches!(issue, AutostartIssue::ExecutablePathInvalid | AutostartIssue::ExecutableMissing)
        });
        let command_valid = !issues.iter().any(|issue| {
            matches!(issue, AutostartIssue::MalformedCommand | AutostartIssue::UnexpectedArguments)
        });
        // status().last_error może zawierać surowy komunikat systemu —
        // zsanityzowana postać to stały, czysty komunikat po polsku.
        let last_error = windows::status().last_error.map(|_| {
            "Nie udało się odczytać bieżącego stanu autostartu.".to_string()
        });
        AutostartDiagnostics {
            windows: true,
            supported: true,
            healthy,
            path_valid,
            command_valid,
            issues: issue_codes(&issues),
            last_error,
            checked_at: now_timestamp(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        AutostartDiagnostics {
            windows: false,
            supported: false,
            healthy: true,
            path_valid: true,
            command_valid: true,
            issues: Vec::new(),
            last_error: None,
            checked_at: now_timestamp(),
        }
    }
}

/// TYLKO DO ODCZYTU: po restarcie Windows lub aktualizacji VELORA raportuje
/// nieaktualny wpis, ale NIGDY nie naprawia go automatycznie. Użytkownik
/// odświeża wpis istniejącym przełącznikiem opt-in (set_autostart_enabled).
#[tauri::command]
pub fn get_autostart_recovery() -> AutostartRecoveryReport {
    let args: Vec<String> = std::env::args().collect();
    let safe_mode = windowed_flag_present(&args);
    #[cfg(target_os = "windows")]
    {
        let value = windows::read_command_value();
        let current_exe = std::env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        let issues = detect_issues(value.as_deref(), current_exe.as_deref());
        let stale = issues.iter().any(|issue| matches!(
            issue,
            AutostartIssue::WrongExecutable
                | AutostartIssue::ExecutablePathInvalid
                | AutostartIssue::MalformedCommand
        ));
        AutostartRecoveryReport {
            windows: true,
            supported: true,
            stale,
            recommended_action: recovery_message(&issues),
            issues: issue_codes(&issues),
            safe_mode,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        AutostartRecoveryReport {
            windows: false,
            supported: false,
            stale: false,
            recommended_action: "Autostart jest dostępny tylko w natywnej aplikacji Windows.".to_string(),
            issues: Vec::new(),
            safe_mode,
        }
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
    use std::path::PathBuf;
    use std::process::Command;

    /// Prefer the absolute system reg.exe so a user-writable working directory
    /// cannot shadow it through the Windows executable search order.
    fn reg_executable() -> PathBuf {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| root.join("System32").join("reg.exe"))
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("reg.exe"))
    }

    fn run_reg(arguments: Vec<String>) -> std::io::Result<std::process::Output> {
        Command::new(reg_executable()).args(&arguments).output()
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

    /// Wyciąga samą wartość polecenia z linii `reg.exe query` (po znaczniku
    /// typu REG_SZ). Tylko odczyt, bez uruchamiania jakichkolwiek poleceń.
    fn command_value_from_line(line: &str) -> Option<String> {
        let marker = "REG_SZ";
        let index = line.find(marker)?;
        let value = line[index + marker.len()..].trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    }

    /// Odczytuje AKTUALNĄ wartość `VELORA` (wyłącznie reg.exe query). Używana
    /// tylko przez czyste komendy diagnostyczne w module nadrzędnym.
    #[cfg(target_os = "windows")]
    pub(super) fn read_command_value() -> Option<String> {
        match run_reg(registry_query_arguments()) {
            Ok(output) => value_line(&output).and_then(|line| command_value_from_line(&line)),
            Err(_) => None,
        }
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

    // ===== Nowe, czyste testy diagnostyki (bez reg.exe, działają na macOS) =====

    fn good_exe() -> &'static str {
        r"C:\Program Files\VELORA\velora.exe"
    }

    fn is_clean_code(code: &str) -> bool {
        let mut chars = code.chars();
        match chars.next() {
            Some(first) if first.is_ascii_lowercase() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric())
    }

    #[test]
    fn validate_executable_path_accepts_a_plausible_absolute_path() {
        assert!(validate_executable_path(good_exe()).is_ok());
    }

    #[test]
    fn validate_executable_path_rejects_invalid_paths() {
        let bad = [
            "",
            "velora.exe",
            "C:\\VELORA\\vel\"ora.exe",
            "C:\\VELORA\\velora.exe\n",
            "C:\\VELORA\\velora\0.exe",
            r"C:\VELORA\..\velora.exe",
            r"C:\VELORA\vel&ora.exe",
            r"C:\VELORA\velora.txt",
        ];
        for path in bad {
            assert!(
                validate_executable_path(path).is_err(),
                "powinno odrzucić: {:?}",
                path
            );
        }
        assert_eq!(
            validate_executable_path("velora.exe"),
            Err(AutostartIssue::ExecutablePathInvalid)
        );
        let too_long = format!("C:\\{}.exe", "a".repeat(1100));
        assert!(validate_executable_path(&too_long).is_err());
    }

    #[test]
    fn parse_command_value_parses_quoted_path_and_windowed_flag() {
        let quoted = format!("\"{}\"", good_exe());
        assert_eq!(
            parse_command_value(&quoted),
            Ok((good_exe().to_string(), false))
        );
        let with_flag = format!("\"{}\" {}", good_exe(), SAFE_MODE_FLAG);
        assert_eq!(
            parse_command_value(&with_flag),
            Ok((good_exe().to_string(), true))
        );
        let unquoted = format!("{} {}", r"C:\VELORA\velora.exe", SAFE_MODE_FLAG);
        assert_eq!(
            parse_command_value(&unquoted),
            Ok((r"C:\VELORA\velora.exe".to_string(), true))
        );
    }

    #[test]
    fn parse_command_value_rejects_injected_quotes_and_newlines() {
        assert!(parse_command_value("\"C:\\VELORA\\velora.exe\" --windowed\"extra").is_err());
        assert!(parse_command_value("C:\\VELORA\\vel\"ora.exe").is_err());
        assert!(parse_command_value("\"C:\\VELORA\\velora.exe\"\n--windowed").is_err());
        assert!(parse_command_value("\"C:\\VELORA\\velora.exe").is_err());
    }

    #[test]
    fn parse_command_value_rejects_extra_args_unquoted_spaces_and_multiple_flags() {
        assert_eq!(
            parse_command_value("\"C:\\VELORA\\velora.exe\" --fullscreen"),
            Err(AutostartIssue::UnexpectedArguments)
        );
        assert!(parse_command_value(r"C:\Program Files\VELORA\velora.exe").is_err());
        let many = format!("\"{}\" {} {}", good_exe(), SAFE_MODE_FLAG, SAFE_MODE_FLAG);
        assert_eq!(
            parse_command_value(&many),
            Err(AutostartIssue::UnexpectedArguments)
        );
        assert_eq!(
            parse_command_value("\"C:\\VELORA\\velora.exe\" --windowed extra"),
            Err(AutostartIssue::UnexpectedArguments)
        );
    }

    #[test]
    fn detect_issues_reports_no_issues_for_a_healthy_value() {
        let value = format!("\"{}\" {}", good_exe(), SAFE_MODE_FLAG);
        let issues = detect_issues(Some(&value), Some(good_exe()));
        assert!(issues.is_empty(), "oczekiwano braku problemów: {:?}", issues);
        assert!(is_healthy(&issues));
    }

    #[test]
    fn detect_issues_reports_missing_value() {
        let issues = detect_issues(None, Some(good_exe()));
        assert_eq!(issues, vec![AutostartIssue::MissingValue]);
        assert!(!is_healthy(&issues));
    }

    #[test]
    fn detect_issues_reports_stale_executable_after_update() {
        let stale = format!("\"{}\"", r"C:\Old\VELORA\velora.exe");
        let issues = detect_issues(Some(&stale), Some(good_exe()));
        assert_eq!(issues, vec![AutostartIssue::WrongExecutable]);
    }

    #[test]
    fn detect_issues_reports_malformed_command() {
        let issues = detect_issues(Some("C:\\VELORA\\velora.exe\" --windowed"), Some(good_exe()));
        assert_eq!(issues.len(), 1);
        assert!(matches!(
            issues[0],
            AutostartIssue::MalformedCommand | AutostartIssue::UnexpectedArguments
        ));
    }

    #[test]
    fn detect_issues_reports_invalid_executable_path() {
        let issues = detect_issues(
            Some("\"C:\\VELORA\\velora.txt\""),
            Some(r"C:\VELORA\velora.txt"),
        );
        assert_eq!(issues, vec![AutostartIssue::ExecutablePathInvalid]);
    }

    #[test]
    fn is_healthy_reflects_absence_of_issues() {
        assert!(is_healthy(&[]));
        assert!(!is_healthy(&[AutostartIssue::WrongExecutable]));
        assert!(!is_healthy(&[AutostartIssue::MissingValue]));
    }

    #[test]
    fn recovery_message_is_clean_and_never_leaks_raw_paths() {
        let cases = [
            vec![],
            vec![AutostartIssue::WrongExecutable],
            vec![AutostartIssue::MissingValue],
            vec![
                AutostartIssue::MalformedCommand,
                AutostartIssue::UnexpectedArguments,
            ],
            vec![AutostartIssue::ExecutablePathInvalid],
            vec![AutostartIssue::QueryFailed(
                "C:\\secret\\os error 0x5 Error: boom".to_string(),
            )],
        ];
        for issues in cases {
            let message = recovery_message(&issues);
            assert!(!message.is_empty());
            assert!(!message.contains("os error"), "wyciek: {}", message);
            assert!(!message.contains("Error:"), "wyciek: {}", message);
            assert!(!message.contains("0x"), "wyciek: {}", message);
            assert!(!message.contains('\\'), "wyciek ścieżki: {}", message);
            assert!(!message.contains("C:"), "wyciek ścieżki: {}", message);
        }
        let stale = recovery_message(&[AutostartIssue::WrongExecutable]);
        assert!(stale.contains("odświeżyć"));
        assert!(stale.contains("Wyłącz i włącz"));
    }

    #[test]
    fn user_message_never_leaks_the_query_failed_payload() {
        let issue = AutostartIssue::QueryFailed(
            "C:\\secret\\velora.exe os error 0x5 Error: boom".to_string(),
        );
        assert_eq!(issue.code(), "queryFailed");
        let message = issue.user_message();
        assert!(!message.contains("os error"));
        assert!(!message.contains("Error:"));
        assert!(!message.contains("0x"));
        assert!(!message.contains('\\'));
        assert!(!message.contains("C:"));
        for variant in [
            AutostartIssue::MissingValue,
            AutostartIssue::MalformedCommand,
            AutostartIssue::ExecutablePathInvalid,
            AutostartIssue::ExecutableMissing,
            AutostartIssue::WrongExecutable,
            AutostartIssue::UnexpectedArguments,
        ] {
            assert!(is_clean_code(variant.code()));
            assert!(!variant.user_message().is_empty());
        }
    }

    #[test]
    fn now_timestamp_is_non_empty() {
        assert!(!now_timestamp().is_empty());
    }

    #[test]
    fn detect_issues_outputs_are_codes_only_without_raw_paths() {
        let healthy = format!("\"{}\"", good_exe());
        let cases = [
            detect_issues(None, Some(good_exe())),
            detect_issues(Some(&healthy), Some(r"D:\Old\VELORA\velora.exe")),
            detect_issues(
                Some("\"C:\\bad\\velora.txt\" --windowed extra"),
                Some(good_exe()),
            ),
            detect_issues(Some(&healthy), Some(good_exe())),
        ];
        for issues in cases {
            for code in issue_codes(&issues) {
                assert!(is_clean_code(&code), "kod nie jest czysty: {}", code);
                assert!(!code.contains('\\'));
                assert!(!code.contains('/'));
                assert!(!code.contains(':'));
                assert!(!code.contains(' '));
            }
        }
    }
}
