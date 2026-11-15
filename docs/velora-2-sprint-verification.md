# Weryfikacja S1.1 + S1.2 (2026-11-15)

Raport roboczy; końcowe wyniki zostaną uzupełnione przed zamknięciem pracy.

S1.1: tsc -b przeszedł. Początkowe Vitest: 86 plików / 796 testów.
Po regresjach A1/A6: 3 pliki / 51 testów przeszło.
Nowe testy Rust A2/A3/A4 przeszły w sandboxie.
Pełny Rust w sandboxie na pierwszym przebiegu: 313 passed / 25 failed;
24 błędy wymagają testowego Credential Manager (Unavailable), jeden dotyczy długiej ścieżki linkera w provenance.
Ponowienie z uprawnieniami systemowego magazynu i krótkim TEMP jest w toku.
Cargo fmt --all -- --check wykazuje istniejące rozbieżności formatowania także w niezmienianych modułach (np. app_manager.rs).
Nie wykonano fizycznych testów kontrolera ani instalacji MSI.
