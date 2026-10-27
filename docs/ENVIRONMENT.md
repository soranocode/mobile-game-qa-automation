# Среда Unity автотестов

Актуальная установка и восстановление — [RESTORE_ON_NEW_PC](RESTORE_ON_NEW_PC.md). Проверенные версии и обязательные компоненты — `config/portable-release.json`.

Основной набор: компилирующийся Unity проект, Unity MCP, пакет `com.gameqa.demonstrations`, Python для офлайн памяти/карты, Node для оркестрации. Машинные пути задаются через `python tools/portable/bootstrap.py init --game-project PATH`; локальная конфигурация исключена из Git.

Офлайн проверка: `python tools/portable/bootstrap.py check` и `python tools/portable/verify_offline.py`. Эти команды не подключаются к Unity и не запускают Play. Проверка реального соединения и любой игровой ввод выполняются отдельно по актуальному запросу QA.
