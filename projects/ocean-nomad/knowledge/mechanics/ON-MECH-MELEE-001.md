# ON-MECH-MELEE-001 — ближний удар и реальная дальность

Ocean Nomad2.11.0dev, Unity6000.0.66f2 Editor; игровой HEAD6f0cba29,23.10.2026. Статус SOURCE_VERIFIED / DEMONSTRATION_PENDING. Проверена реализация, не агентное боевое прохождение.

## Контекст крюка

Hook.Act(item) при IsWeapon() вызывает Hit(item). IsWeapon истинно при SharkAttackObserver.IsSharkAttack, а также на Island/EnemyAnchor. На плоту при нападении обычный UIControlsButton1 с Hook вызывает ближний удар; продолжать считать его сбором нельзя. Крючок на верёвке — другое действие: PlayerHookEnemyCollision наносит акуле0урона и показывает HookHitShark.

Обычная кнопка идёт через HudControlsManager → ActivityController, где есть guards готовности рук/летящего крюка/fishing и приоритетные контекстные IActivityNonThing. Активное имя Hook само по себе не доказывает, что сейчас будет throw или hit: нужен контекст нападения/позиции и фактическое действие. Не обходить эти guards прямым private Hit/уроном.

## Проверка дистанции

Weapon.CheckEnemyNear создаёт ray из Camera.main через центр экрана, затем SphereCastNonAlloc(ray,0.33,buffer,_range), выбирая первый найденный Enemy collider. _range берётся из WeaponModel.Range по UID предмета. Проверка фактического попадания вызывается callback анимации, поэтому прицел/дистанция важны в этот момент. Range — длина протянутой сферы от камеры; не расстояние от ног игрока до pivot акулы. Радиус0.33 также часть геометрии. Явной сортировки collider по близости в этом коде нет.

Локальные базовые значения WeaponDatabase (не гарантия текущего runtime): Hook Range1.1/AttackTime1с/урон4–8; WoodenHook Range1.1/1.5с/2–3; MetalHook/GoldenHook тожеRange1.1. WoodenSpear1.7, MetalSpear1.8. Skill modifiers в найденной цепочке меняют damage, не Range. Для действия брать UID текущего предмета и реально загруженную модель.

## Почему1.6 не является attack range

EnemiesMaskLogicHandler при автоматическом подходе по клику на врага берёт первый Kind=Weapon на поясе, может сменить слот, и задаёт AutoMove.MinDistance=weapon.Range. При SharkAttack и Range<=1.1 добавляет0.5. Это даёт1.6 для Hook как порог автоходьбы, но hit SphereCast остаётся1.1. AutoMove сравнивает3D player-transform→enemy.ViewDamage.position; другая геометрия, не универсальная дальность. Нельзя просто идти к pivot/в воду до такого расстояния и считать удар обеспеченным.

## Применение к будущему навыку

Обнаружить [атаку](../entities/ON-ENEMY-SHARK-001.md), получить актуального врага/collider, выбрать доступную позицию на настиле, подойти обычным управлением, навести текущий взгляд и нажать обычное использование. Подтвердить реальный урон/анимацию и исход. Бюджет/ритм ударов, подход, остановка у края и реакция на урон ещё должны быть показаны и проверены. Правило3сек крюка-сборщика не переносить на melee: механика и базовый attack time другие. Один удар и фиксированное число ударов не гарантируют отпугивание.

Переиспользуется определение наведения ON-CONTROL-MOVE-LOOK-001. Текущий AimHookAction привязан к quest Pickable и не является готовым наведением/подходом к врагу; требуется иной наблюдатель целей. Одобренный hook_use не расширен автоматически на бой.

## Источники

- Assets/Scripts/Survival/Activities/Hook.cs:97–104,349–351 — Act/IsWeapon.
- Assets/Scripts/Survival/Activities/Weapon.cs:118,125–140,197–220,232–250 — callback, модель, sphere cast.
- Assets/Settings/Settings/WeaponDatabase.asset:25–30,46–72,88–93 — базовые параметры.
- Assets/Scripts/Survival/Widgets/UI/Controll/Masks/Impl/EnemiesMaskLogicHandler.cs:59–106; Assets/Scripts/Survival/Windows/Panels/BeltManager.cs:40–53; MovementController.cs:365–377 — выбор оружия и автоходьба.
- Assets/Scripts/Survival/Windows/Panels/HudControlsManager.cs:218–239; Assets/Scripts/Survival/Activities/ActivityController.cs:140–285,439–458 — Use/context.
- Assets/Scripts/Survival/Enemy/Player/PlayerHookEnemyCollision.cs:43–55 — бросок не равен melee.

Связи: ON-ENEMY-SHARK-001, ON-MECH-HOOK-001, ON-CONTROL-MOVE-LOOK-001, ON-WORLD-RAFT-001.


## Обновление26.10

26.10: обычный ближний бой Hook подтверждён в живой сцене и одобрен человеком. Подход по настилу, range1.1, 6 ударов/27урона, HP100→73 и fresh retreat за9.323с. Контракт ON-COMBAT-SHARK-MELEE-001, обработчик ON-SAFETY-SHARK-DEFENSE-001. Копьё не проверено; не переносить этот апрув на все виды оружия.
