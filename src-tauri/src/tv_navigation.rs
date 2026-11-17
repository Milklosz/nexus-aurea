//! Shared native TV navigation contracts and conservative service profiles.
//!
//! These profiles describe a candidate input path. A Windows input receipt
//! reports that the OS accepted the bounded command; it does not prove that a
//! streaming page changed playback state.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NavigationMode {
    #[default]
    Automatic,
    Keyboard,
    Spatial,
    Pointer,
}

impl NavigationMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "keyboard" => Ok(Self::Keyboard),
            "spatial" => Ok(Self::Spatial),
            "pointer" => Ok(Self::Pointer),
            _ => Err("Tryb nawigacji musi być automatic, keyboard, spatial albo pointer.".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Keyboard => "keyboard",
            Self::Spatial => "spatial",
            Self::Pointer => "pointer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavigationAction {
    Up,
    Down,
    Left,
    Right,
    Confirm,
    Back,
    Home,
    PlayPause,
    SeekBackward,
    SeekForward,
    Fullscreen,
    PlayerMute,
    SystemVolumeUp,
    SystemVolumeDown,
    SystemMute,
    Captions,
    PreviousSection,
    NextSection,
    ScrollUp,
    ScrollDown,
    PointerMove(i32, i32),
    PointerClick,
    PointerBack,
    PointerToggle,
    OpenControlCenter,
}

impl NavigationAction {
    /// Converts only the simulator's documented action names. Values never
    /// become key codes, window handles, or process identifiers.
    pub fn from_simulator_name(name: &str, delta_x: i32, delta_y: i32) -> Result<Self, String> {
        let bounded_x = delta_x.clamp(-32, 32);
        let bounded_y = delta_y.clamp(-32, 32);
        match name {
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            "confirm" => Ok(Self::Confirm),
            "back" => Ok(Self::Back),
            "home" => Ok(Self::Home),
            "playPause" => Ok(Self::PlayPause),
            "seekBackward" => Ok(Self::SeekBackward),
            "seekForward" => Ok(Self::SeekForward),
            "fullscreen" => Ok(Self::Fullscreen),
            "playerMute" => Ok(Self::PlayerMute),
            "volumeUp" => Ok(Self::SystemVolumeUp),
            "volumeDown" => Ok(Self::SystemVolumeDown),
            "mute" => Ok(Self::SystemMute),
            "captions" => Ok(Self::Captions),
            "previousSection" => Ok(Self::PreviousSection),
            "nextSection" => Ok(Self::NextSection),
            "scrollUp" => Ok(Self::ScrollUp),
            "scrollDown" => Ok(Self::ScrollDown),
            "pointerMove" => Ok(Self::PointerMove(bounded_x, bounded_y)),
            "pointerClick" | "click" => Ok(Self::PointerClick),
            "pointerBack" => Ok(Self::PointerBack),
            "pointerToggle" => Ok(Self::PointerToggle),
            "openControlCenter" => Ok(Self::OpenControlCenter),
            _ => Err("Nieznana akcja symulatora.".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvNavigationProfile {
    pub profile_version: u16,
    pub service_id: &'static str,
    pub label: &'static str,
    pub supported_strategies: &'static [NavigationMode],
    pub tested_environments: &'static [&'static str],
    pub official_reference: &'static str,
    pub back_behavior: &'static str,
    pub scroll_behavior: &'static str,
    pub fullscreen_behavior: &'static str,
    pub automatic_strategy: &'static str,
    pub keyboard: &'static str,
    pub spatial: &'static str,
    pub pointer: &'static str,
    pub playback_shortcuts: &'static str,
    pub limitations: &'static str,
}

/// No profile claims site behavior or hardware validation. Automatic uses the
/// conservative keyboard path for navigation; media shortcuts are separately
/// allowlisted below and still require a playback arm and editable-focus check.
const CANDIDATE_STRATEGIES: &[NavigationMode] = &[
    NavigationMode::Keyboard,
    NavigationMode::Spatial,
    NavigationMode::Pointer,
];
const BROWSER_BACK: &str =
    "Alt+Left browser history; site dialogs may need explicit focused controls";
const OWNED_SCROLL: &str = "User-driven wheel only within unobscured owned client area";
pub const PROFILES: &[TvNavigationProfile] = &[
    TvNavigationProfile {
        profile_version: 1,
        service_id: "netflix",
        label: "Netflix",
        supported_strategies: CANDIDATE_STRATEGIES,
        tested_environments: &[],
        official_reference: "https://help.netflix.com/en/node/24855",
        back_behavior: BROWSER_BACK,
        scroll_behavior: OWNED_SCROLL,
        fullscreen_behavior: "F in armed player context; Esc exits; live effect unverified",
        automatic_strategy: "keyboard",
        keyboard: "available; browser behavior varies by page",
        spatial: "candidate; UI Automation provider may expose no usable controls",
        pointer: "bounded to the owned Edge client area",
        playback_shortcuts: "Space/Enter, Left/Right and F are documented candidates; page effect unverified",
        limitations: "Website layout, player focus and DRM behavior were not verified on hardware.",
    },
    TvNavigationProfile {
        profile_version: 1,
        service_id: "disney",
        label: "Disney+",
        supported_strategies: CANDIDATE_STRATEGIES,
        tested_environments: &[],
        official_reference: "https://help.disneyplus.com/en-GB/article/disneyplus-en-tr-accessibility",
        back_behavior: BROWSER_BACK,
        scroll_behavior: OWNED_SCROLL,
        fullscreen_behavior: "Explicit player control via keyboard focus, UIA or pointer; no shortcut assumed",
        automatic_strategy: "keyboard",
        keyboard: "candidate; service UI behavior unverified",
        spatial: "candidate; UI Automation provider may expose no usable controls",
        pointer: "bounded to the owned Edge client area",
        playback_shortcuts: "unsupported until an official service shortcut is verified",
        limitations: "No service-specific media shortcut is enabled; website and DRM behavior are unverified.",
    },
    TvNavigationProfile {
        profile_version: 1,
        service_id: "max",
        label: "Max",
        supported_strategies: CANDIDATE_STRATEGIES,
        tested_environments: &[],
        official_reference: "https://help.hbomax.com/GB/Answer/Detail/000002553",
        back_behavior: BROWSER_BACK,
        scroll_behavior: OWNED_SCROLL,
        fullscreen_behavior: "Explicit player control via keyboard focus, UIA or pointer; no shortcut assumed",
        automatic_strategy: "keyboard",
        keyboard: "Tab/arrows navigate, Enter links, Space selects, Esc menus per official help; live effect unverified",
        spatial: "candidate; UI Automation provider may expose no usable controls",
        pointer: "bounded to the owned Edge client area",
        playback_shortcuts: "unsupported until an official service shortcut is verified",
        limitations: "No service-specific media shortcut is enabled; website and DRM behavior are unverified.",
    },
    TvNavigationProfile {
        profile_version: 1,
        service_id: "prime",
        label: "Prime Video",
        supported_strategies: CANDIDATE_STRATEGIES,
        tested_environments: &[],
        official_reference: "https://www.primevideo.com/help?nodeId=GE4VW9VWJD7FM6DR",
        back_behavior: BROWSER_BACK,
        scroll_behavior: OWNED_SCROLL,
        fullscreen_behavior: "F in armed player context; Esc exits; live effect unverified",
        automatic_strategy: "keyboard",
        keyboard: "candidate; service UI behavior unverified",
        spatial: "candidate; UI Automation provider may expose no usable controls",
        pointer: "bounded to the owned Edge client area",
        playback_shortcuts: "Space, Left/Right, F, M and C are documented candidates; page effect unverified",
        limitations: "Purchase, rental, subscription and account controls are restricted test targets. Player effect and DRM behavior unverified.",
    },
    TvNavigationProfile {
        profile_version: 1,
        service_id: "youtube",
        label: "YouTube",
        supported_strategies: CANDIDATE_STRATEGIES,
        tested_environments: &[],
        official_reference: "https://support.google.com/youtube/answer/7631406",
        back_behavior: BROWSER_BACK,
        scroll_behavior: OWNED_SCROLL,
        fullscreen_behavior: "F in armed player context; Esc exits; live effect unverified",
        automatic_strategy: "keyboard",
        keyboard: "available; browser behavior varies by page",
        spatial: "candidate; UI Automation provider may expose no usable controls",
        pointer: "bounded to the owned Edge client area",
        playback_shortcuts: "K, J, L, F and M are documented candidates; page effect unverified",
        limitations: "Player focus is required for media shortcuts; editable-focus guard and arm are enforced.",
    },
];

pub fn profile(service_id: &str) -> Option<&'static TvNavigationProfile> {
    PROFILES
        .iter()
        .find(|profile| profile.service_id == service_id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationTargetSession {
    pub session_id: String,
    pub service_id: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationDiagnostics {
    pub accepted_actions: u64,
    pub rejected_actions: u64,
    pub dropped_reports: u64,
    pub queue_depth: usize,
    pub last_source: Option<String>,
    pub last_controller_id: Option<String>,
    pub last_repeat: bool,
    pub last_sequence: u64,
    pub last_routing_decision: Option<String>,
    pub last_target_present: bool,
    pub last_action_at_ms: Option<u64>,
    pub dispatch_elapsed_ms: Option<u64>,
    pub spatial_query_ms: Option<u64>,
    pub spatial_candidate_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvNavigationStatus {
    pub windows: bool,
    pub enabled: bool,
    pub simulator_available: bool,
    pub mode: NavigationMode,
    pub active_strategy: String,
    pub active_service: Option<String>,
    pub target_session: Option<NavigationTargetSession>,
    pub media_control_session: Option<NavigationTargetSession>,
    pub generation: u64,
    pub media_controls_armed: bool,
    pub last_result: Option<String>,
    pub profiles: &'static [TvNavigationProfile],
    pub diagnostics: NavigationDiagnostics,
    pub last_simulator_sequence: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationActionReceipt {
    pub accepted: bool,
    pub effect: String,
    pub sequence: u64,
    pub generation: u64,
    pub mode: NavigationMode,
    pub active_strategy: String,
    pub target_session: Option<String>,
    pub last_result: Option<String>,
    pub ownership: Option<String>,
    pub dispatch_elapsed_ms: u64,
    pub spatial_query_ms: Option<u64>,
    pub spatial_candidate_count: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::{profile, NavigationAction, NavigationMode, PROFILES};

    #[test]
    fn mode_parser_is_a_closed_allowlist() {
        assert_eq!(
            NavigationMode::parse("automatic").unwrap(),
            NavigationMode::Automatic
        );
        assert_eq!(
            NavigationMode::parse("spatial").unwrap(),
            NavigationMode::Spatial
        );
        for value in ["", "pointer;cmd", "background", "unknown"] {
            assert!(NavigationMode::parse(value).is_err());
        }
    }

    #[test]
    fn simulator_actions_clamp_pointer_motion_and_reject_unknown_names() {
        assert_eq!(
            NavigationAction::from_simulator_name("pointerMove", 900, -900).unwrap(),
            NavigationAction::PointerMove(32, -32)
        );
        assert!(NavigationAction::from_simulator_name("key:Alt+F4", 0, 0).is_err());
    }

    #[test]
    fn all_five_profiles_are_conservative_and_known() {
        assert_eq!(PROFILES.len(), 5);
        for id in ["netflix", "disney", "max", "prime", "youtube"] {
            let service = profile(id).unwrap();
            assert_eq!(service.profile_version, 1);
            assert!(service.tested_environments.is_empty());
            assert_eq!(service.supported_strategies.len(), 3);
            assert!(service.official_reference.starts_with("https://"));
            assert!(!service.back_behavior.is_empty());
            assert!(!service.scroll_behavior.is_empty());
            assert!(!service.fullscreen_behavior.is_empty());
            assert_eq!(service.automatic_strategy, "keyboard");
            assert!(!service.limitations.is_empty());
        }
        assert!(profile("arbitrary.example").is_none());
    }
}
