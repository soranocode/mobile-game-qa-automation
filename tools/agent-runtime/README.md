# Подготовленный исполнитель

Этот модуль не запускает агентов, не подключается к MCP и не начинает игру при импорте.
Координатор назначает одного исполнителя и передаёт актуальное разрешённое задание.

Основная точка составного запуска — `tools/portable/runtime.mjs#runPipeline` (также `runMissions`). [Описание конвейера](../../brain/agents/PIPELINE.md): до старта прогрев всех Unity команд; во время текущей миссии подготовка следующих двух пакетов без MCP; один владелец ввода и наблюдатель ошибок на весь цикл; журнал событий в процессе и финальный анализ с предложениями знаний после цикла. `pipeline.mjs` реализует очередь, `cycle-journal.mjs` — доказательства, `cycle-analysis.mjs` — анализ. Новая обвязка проверена офлайн; игровой замер ещё не проведён. `executeSelectedMissions`/`runMissionSequence` сохранены как прежний последовательный интерфейс без нового конвейера.

- `MissionPool.prepare` сохраняет готовый handler по миссии, эпохе Unity и ревизии пакета. Повтор не вызывает factory заново.
- `prepareHookMission({session,parameterDirectory})` прогревает существующие bindings/aim/наблюдение без игрового ввода и возвращает handler для hook_use. Нужны уже проверенное подключение и текущая сцена Game. Локальный parameterDirectory держать вне Git.
- `MissionPool.run` требует заново переданные taskId/authorized, подходящие epoch/revision и свободного исполнителя. authorized — утверждение координатора, не обход разрешений среды.
- `stop` вызывает отмену и сохраняет блокировку до выхода активного handler. Обработчик следит за AbortSignal на границах команд.
- Полный отчёт hook_use сохраняется в parameterDirectory/evidence. Возврат координатору содержит только результат, свежесть 3/3, время, число попыток, ошибки/cleanup и ссылку на отчёт.
- После перезапуска Unity/процесса, domain reload или изменения пакета подготовить заново. Не использовать сохранённые координаты и не продолжать автоматически после неизвестного исхода.

Для intro/control/wooden_hook/shark_attack добавлены отдельные factories в `onboarding-runner.mjs`. Общие правила и различение текстового кеша, офлайн проверки и реальной готовности Unity — в [PREPARED_MISSIONS.md](PREPARED_MISSIONS.md). `getMissionPool()` даёт стабильную точку вызова, `readiness` проверяет настоящий handler текущей эпохи, `runMissionSequence` не проходит дальше неуспешной миссии.

Проверки без Unity:

```powershell
node tools/agent-runtime/mission-pool.test.mjs
node tools/agent-runtime/hook-runner.test.mjs
node tools/agent-runtime/onboarding-runner.test.mjs
python -m unittest discover -s tools/knowledge -p test_dispatch.py
```

Транспорт в тестах имитируется. Прежний игровой навык hook_use был проверен live отдельно; новые control/wooden_hook прошли с апрувом скорости 27.10; intro исправлен после подсказки, полный расширенный набор ещё не подтверждён одним прогоном.

`verify_prepared_csharp.py --project LOCAL_GAME --editor-data LOCAL_EDITOR_DATA` проверяет 11 C# сниппетов, включая примитив входа и пять команд управления циклом, по существующим csproj и сборкам Unity/игры без запуска Editor. Проверены имена типов и API; guard в этой проверке заменён stub и поведение игры не проверяется. Артефакты остаются в игнорируемом work/.
