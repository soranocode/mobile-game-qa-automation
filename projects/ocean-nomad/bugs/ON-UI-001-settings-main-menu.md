# ON-UI-001 — Настройки не открываются из главного меню

**Окружение:** Ocean Nomad 2.11.0 (dev), Unity Editor 6000.0.66f2. Дата: 22.10.2026.

**Шаги:**
1. Открыть главное меню игры.
2. Нажать шестерёнку в правом верхнем углу.

**Ожидается:** открывается окно настроек.

**Фактически:** окно не открывается, на экране остаётся главное меню. В Console возникает ошибка:
`VContainerException: Failed to resolve Survival.Windows.PauseManager : No such registration of type: RateUs.ShowRateUsMail`

**Влияние:** настройки недоступны из главного меню; проверка их элементов из этой точки входа заблокирована.

**Воспроизведение:** 2/2 нажатия через MCP/EventSystem, включая центр кнопки и ожидание 3 с. Стек ошибки проходит через `UISimpleButton.OnPointerUp` → `WindowsController.Open` → `PrefabsFactory.Get` → VContainer. На устройстве не проверялось.

**Доказательства:** локальный эпизод в `outputs/unity-mcp/settings-main-menu/`; `attempts.json`, `pause-manager-errors.json`, скриншоты `before-settings.png` / `after-settings.png`. Сырые данные в Git не включены.
