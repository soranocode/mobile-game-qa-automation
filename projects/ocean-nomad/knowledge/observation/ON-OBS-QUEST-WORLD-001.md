# ON-OBS-QUEST-WORLD-001 — квест, предметы и координаты в записи

Игра: Ocean Nomad 2.11.0 dev, Unity6000.0.66f2. Обновлено23.10.2026. Статус: **provisional; модуль0.2.0 прошёл технические проверки и проверен на реальной записи Hook use23.10**.

## Где заданы цели

Активные миссии читает QuestManager; IActiveQuest содержит активные/начатые шаги. ActiveQuestStep хранит Value, Need, IsComplete и параметры цели. Для hands_collect шаг res_collected имеет тип ObjectCollect, UID LogTutotial и TrashTutorial, требование2. Триггеры создают соответствующие PickableComponent и QuestObject. Pickable.Uid — тип цели; QuestObject.Id — сохраняемый ID объекта; instance_id — конкретный экземпляр текущего Editor. Эти ID не взаимозаменяемы.

## Что реализовано

Пакет com.gameqa.demonstrations0.2.0 автоматически пишет module_id=ocean.quest-world при записи демонстрации:

- quest_snapshot: доступность источника, loaded, отслеживаемая/активные миссии, активные шаги, тип, UID целей, Value/Need/IsComplete. Читаются только UID-параметры; пароли/введённый текст не записываются.
- spatial_snapshot: соответствующие наблюдавшимся ObjectCollect-целям загруженные PickableComponent, их UID/instance_id/QuestObject.Id, активность/взятость/CanPickup, мировые и локальные координаты, расстояния до точки наведения от игрока/камеры, ошибки yaw/elevation.

Исходный снимок и финальный снимок пишутся автоматически; между ними — изменения до5Гц и контрольный снимок через2с. Источники/список компонентов ищутся не чаще1Гц; положения уже найденных объектов читаются на момент снимка. Это выборки состояния, не гарантированная запись каждого промежуточного игрового события. Отсутствующее поле остаётся unknown/null. QuestManager берётся из уже созданных TestGUI._activePanelList[*]._questManager; при отсутствии/неоднозначности ссылки данные квеста неизвестны. Resolve/создание сервисов/игровые действия не вызываются.

Ограничения вывода:16активных миссий,32шага,32UID на шаг,32целевых объекта; каталог наблюдавшихся UID/миссий ограничен64. Скан Pickable ограничен4096, история —512записями. Флаги truncation/limit показывают неполноту. Поиск неактивных объектов нужен, чтобы видеть результат подбора и проблему сохранённого состояния.

## Как понимать пространство

Координаты относятся к текущим загруженным сценам Unity; это не координаты глобальной карты и не неизменные точки маршрута. Вместе с ними сохраняются frame/time, сцена, instanceID и преобразование родителя игрока. position_in_player_parent — координаты цели в этой системе; родитель не объявляется автоматически плотом.

Точка наведения — центр доступного коллайдера, иначе transform с пометкой fallback. yaw_error_degrees_positive_right: положительный угол вправо; elevation_error_degrees_positive_up: положительный угол вверх. Это геометрическая поправка взгляда; знак/сила реального Look-drag требуют калибровки управления. Модуль не меняет поворот камеры и не двигает игрока.

ReadSnapshot() и ReadNearby(radius,limit) можно вызвать через MCP execute_code как методы нашего адаптера; отдельными нативными MCP-tools они не зарегистрированы. Nearby ограничен радиусом(0,200]unity units и1..64объектами, требует известного игрока. Пустой ответ не доказывает отсутствие ресурса вне покрытия/кэша/загруженной локации.

## Граница доказательства результата

Близость и CanPickup не доказывают текущую выбранную цель Pickup, видимость или безопасный проход: selected_pickup_target/visible/reachable остаются null, path_status=not_evaluated. Новый маршрут, препятствия, опора и обход ещё не вычисляются. Для плавающего ресурса нужна доступная позиция взаимодействия на плоту, а не ходьба в точку предмета в воде.

history_completed_observed_quest_uids — историческое членство только для миссий, наблюдавшихся в сессии. Старый флаг завершения не доказывает успех нового повтора. Анализатор сохраняет ссылки на seq последних снимков и completion=not_inferred. Инвентарь/фактическая выдача награды пока не записываются этим модулем.

Связи: [hands_collect](../missions/ON-QUEST-HANDS-COLLECT-001.md), [пространство плота](../world/ON-WORLD-RAFT-001.md), [Pickup](../mechanics/ON-MECH-PICKUP-001.md), [управление](../controls/ON-CONTROL-MOVE-LOOK-001.md).

Источники: `Assets/Scripts/Quests/QuestManager.cs`; `Assets/Scripts/Quests/ActiveQuests/IActiveQuest.cs`; `Assets/Scripts/Quests/Steps/ActiveQuestStep.cs`; `Assets/Scripts/Quests/Objects/QuestObject.cs`; `Assets/Scripts/Survival/Components/PickableComponent.cs`; `Assets/Scripts/TestBuild/TestGUIs/Panel/CompleteQuestsPanel.cs`; `Assets/Settings/Settings/Quest/QuestStepsDatabase.asset:42`. Реализация: packages/com.gameqa.demonstrations/Adapters/OceanNomad/OceanNomadTelemetry.cs и WorldTargetProjection.cs. Сырые доказательства локальны; реальная запись новой версии проверена23.10.

## Реальная запись0.2.0: Hook use23.10

Сессия f2319e70d4704f15a62b7f418adc90d6,43.578с,2060событий:28quest_snapshot и75spatial_snapshot, source available/loaded. Обнаружение Game/TestGUI работает в этой человеческой демонстрации. Зафиксированы точные UID/прогресс hook_use0/3→1/3→2/3, состояние taken/inactive ящика/бочки, координаты и углы; wooden_hook0/1→1/1 IsComplete=true. Последний3/3 и taken бревна не попали в выборки: на18.736с квест/цели уже исчезли. Это подтверждает полезность модуля и границу выборочной записи; исчезновение не равно полному доказательству третьего подбора. Результат hook_use дополнительно подтверждён человеком.

История completed уже содержит hook_use/wooden_hook при начале активных шагов; старый флаг не использовать для нового PASS. Инвентарь/экипировка/фазы Hook по-прежнему не записываются. Источник: локальная raft-qa-demonstrations/20261023T104034Z-f2319e70/analysis/semantic-evidence.json. Связи: [hook_use](../missions/ON-QUEST-HOOK-USE-001.md), [wooden_hook](../missions/ON-QUEST-WOODEN-HOOK-001.md).
