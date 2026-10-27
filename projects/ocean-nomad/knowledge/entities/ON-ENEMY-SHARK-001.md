# ON-ENEMY-SHARK-001 — нападение акулы на плот

Ocean Nomad2.11.0dev, Unity6000.0.66f2 Editor; локальный игровой HEAD6f0cba29. Обновлено23.10.2026. Статус SOURCE_VERIFIED / HUMAN_DEMONSTRATION_PENDING: прочитаны исходники и базовые настройки; нападение/ввод/Play не запускались, текущий runtime не опрашивался. Боевой навык и постоянный наблюдатель ещё не подключены.

## Требование человека

Замечать надпись о нападении, определить актуальную атакующую акулу, подойти на дистанцию удара по плоту и нажать обычное использование; с крюком это тоже удар. Если не отбиться, акула ломает плот. Человек собирается вызвать атаку через чит и записать действия. Это новое обучение; апрув hook_use не является апрувом боя/подхода.

## Начало, надпись и пассивный сигнал

При GotIntoPositionForRaftAttack с допустимой целью SharkAISystem вызывает SharkAttacked(true), StatisticsHappened enemy.shark.RaftAttack и alert SharkAttack. Надпись SharkAttack.Txt — «Акула атакует плот!». Она рисуется через AlertsWindow enemy-view.

Уже существует public static read-only Survival.Ai.EnemyShark.SharkDetector.SharkAttackObserver.IsSharkAttack; обновляется SharkAttacked. Это удобный источник attack_active при известной живой игровой сцене/инициализированном наблюдателе, не новый MCP-инструмент. false при неизвестном источнике нельзя трактовать как отсутствие врага. SharkDetectorManager.IsSharkAttacking — другое состояние обнаружения игрока в воде, не заменяет нападение на плот.

Console содержит D.Log: Shark status changed to AttackRaft, Scheduling Shark raft attack in m:ss, AlertsManager Showing alert SharkAttack. D.Log ограничен DEBUG/настройкой логирования; StatisticsAdd/Happened — внутренние события, не обещанные строки Console. Обнаружение строить по состоянию/сигналу, надпись и лог использовать как дополнительные доказательства.

## Периодичность

Интервал не фиксирован: ExtraSettings.SharkAttackRaftTime +15 + Random.Range(min_delay_next_shark_attack,max_delay_next_shark_attack). В локальных defaults25+15+Random.Range(300,500), то есть340–539с активного таймера. Загруженные remote параметры и учебные overrides требуют отдельного чтения; это не гарантированный wall-clock период. При Pause, переносе построек, AutoAttack=false или позиции не Anchor таймер приостановлен; включение автоатак gated завершением remote quest (default shark_attack_2). В Sandbox binding отличается. Не ждать нападения по одному жёсткому таймеру и не выводить отсутствие сигнала из истечения ожидаемых минут.

## Завершение и проверка результата

Отступление при AttackRaft: HealthWhenStartedRaftAttack - Health >= MaxHealth * HpToStopAttackingRaft; default0.25, runtime/квест могут переопределить. Уход сопровождается Patrol и статистикой enemy.shark.AttackRaft.retreat. Таймаут грызения разрушает выбранную постройку и отправляет enemy.shark.AttackRaft.timeout. SharkAttacked(false) и SharkDestroy бывают при разных исходах, не являются самостоятельным PASS отбивания. Проверять причину ухода и состояние выбранной постройки/её ID; неизвестный исход оставлять unknown. Убийство/деспавн — отдельные исходы, без наблюдения не приравнивать к retreat.

## Учебный запуск

Семантический путь: TestGUI → GamePlay → Shark Raft Attack. Кнопка использует обычный ForceAttackRaft механизм; здесь её не нажимали. Не путать с Quests или CompleteQuests. Текущие параметры атаки перед демонстрацией важны: учебный shark_attack задаёт ForceDestroyRaft=true, AttackTime10, HPToStop0.25 — при снятии атаки post-cleanup может тоже разрушить сегмент. В shark_attack_2 ForceDestroy=false. Потерю сегмента при intentional override не объявлять ошибкой нового боевого навыка.

## Что требуется наблюдать при демонстрации

Минимальный будущий снимок: frame/time, source_available, attack_active, конкретный enemy ID/статус, hit point/collider и позиция, player/camera, held item/range, текущая цель-постройка и её существование/состояние, health/maxHealth/damage_since_start, runtime AttackTime/HpToStop/ForceDestroy, outcome retreat|timeout|death|unknown. На событие false→true подавать компактные данные; не перечитывать всю память. Существующий recorder0.2.0 пишет ввод/player/camera/quest-world, отдельные shark/damage/outcome поля в нём не реализованы. Запись не должна автоматически считаться полным боевым логом.

Позиции/ID и реально загруженные параметры не изучены. Данные источников не заменяют показ подхода, наведения, нескольких ударов и результата. Для этого пригодны видео плюс журнал, если доступны; при журнале без видео опираться на фактически записанные поля и объяснение человека.

## Источники

- Assets/Scripts/Enemy/BrutalShark/SharkAISystem.cs:58,127–138,333–340,374–406 — статус, сигнал, UI, retreat/stop.
- Assets/Scripts/Enemy/Shark/SharkDetector/SharkAttackObserver.cs:20–33 — static флаг.
- Assets/Scripts/Enemy/BrutalShark/TriggerRealisations/BrutalSharkStartAttackRaftTrigger.cs:50–54,93,107,150–153 — таймер, паузы, лог.
- Assets/Scripts/Enemy/Shark/RaftSharkManager.cs:105–128; Assets/Scripts/FirebaseRemoteConfigure/InitialSettings/Impl/SharkGetDefaultHandler.cs:13–16; Assets/Settings/Settings/ExtraSettings.asset:25 — gate/defaults.
- Assets/Settings/Settings/AlertValueDatabase.asset:298; Assets/Settings/Settings/LocalizationKeyDatabase.asset:77855–77861; Assets/Scripts/Alerts/AlertsWindow.cs:81–90; AlertsManager.cs:137; Assets/Plugins/Extensions/D.cs:65 — надпись/логи.
- Assets/Scripts/TestBuild/TestGUIs/Panel/GamePlay.cs:98–100 — кнопка вызова.
- Assets/Scripts/Enemy/BrutalShark/ExecutorRealisations/BrutalSharkGnawRaftExecutor.cs:47–90; Assets/Scripts/Quests/Triggers/Types/SharkAttackTrigger.cs:17–19; Assets/Settings/Settings/Quest/QuestTriggerDatabase.asset:453–456,949 — разрушение/overrides.

Связи: ON-MECH-MELEE-001, ON-WORLD-RAFT-001, ON-CONTROL-MOVE-LOOK-001, ON-UI-ERRORWATCH-001, ON-MECH-HOOK-001.


## Обновление26.10

26.10: реальные нападения и отступления наблюдались; человек отдельно одобрил огнестрел и Hook. Рабочий sleeping supervisor и ограничения — ON-SAFETY-SHARK-DEFENSE-001; одобренный бой — ON-COMBAT-SHARK-MELEE-001. Старые абзацы выше описывают стадию23.10, не текущую готовность. Источник атаки не влияет на реакцию; не перезапускать уже активный shark_attack.
