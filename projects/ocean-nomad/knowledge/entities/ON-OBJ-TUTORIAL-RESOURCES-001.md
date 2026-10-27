# ON-OBJ-TUTORIAL-RESOURCES-001 — учебное бревно и мусор

Игра: Ocean Nomad 2.11.0 dev. Среда: Unity Editor. Статус: **provisional**, определения проверены по исходникам 23.10.2026; человеческий сбор заявлен, агентом ещё не выполнен.

- `LogTutotial` — точный UID учебного бревна, включая опечатку. Модель при создании: `Log`; ID сохраняемого объекта: `res_collected_log`.
- `TrashTutorial` — UID учебного мусора. Модель: `SM_Trash_06`; ID сохраняемого объекта: `res_collected_trash`.
- Это два конкретных вида объектов миссии `hands_collect`. Обычные `Log`, `Trash`, `Box` вокруг плота не становятся учебными целями из-за похожего вида.
- UID типа, runtime instance ID и ID сохраняемого объекта имеют разный смысл. Instance ID различает экземпляры только в текущей сессии. UID контейнера не следует считать UID полученного предмета инвентаря.
- Положение, активность, `CanPickup` и `IsTaken` — свежие признаки экземпляра, не постоянные свойства справочника.

Связи: ON-MECH-PICKUP-001, ON-WORLD-RAFT-001, ON-QUEST-HANDS-COLLECT-001, ON-LIMIT-QUEST-OBJECT-STATE-001.

Источники в игровом checkout: `Assets/Settings/Settings/Quest/QuestTriggerDatabase.asset:71`; `Assets/Scripts/Survival/Components/PickableComponent.cs`. Доказательство состояния 22.10: локальный `unity-mcp/quest-replay/2026-10-22T13-32-58.413Z/report.json`.
