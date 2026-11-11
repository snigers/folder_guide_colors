# Заимствованные решения

## Colorize Folder Tree

- Источник: [Raj-Srikar/colorize-folder-tree](https://github.com/Raj-Srikar/colorize-folder-tree/tree/c3e8793ca01e204000e6f4d394a8b9367171bb24).
- Исследованы `extension.js` и `colorize-folder-tree.always.css`.
- Адаптированы шесть цветов и CSS-селекторы `nth-child(6n+X)` в [src/style.js](src/style.js).
- Удалены окраска стрелок и изменение файлов установки; правила ограничены направляющими штатного Explorer.
- MIT, Copyright (c) 2026 Raj Srikar. Полный текст: [лицензия](third-party/colorize-folder-tree.LICENSE.txt).

## slack-themes

- Источник: [poiley/slack-themes](https://github.com/poiley/slack-themes/tree/779793c2d5e630acaabb61878038dd8964a3a103).
- Исследован `src/inject-css.js`.
- Адаптирован приём `Runtime.evaluate` → именованный элемент style → `textContent` в [src/style.js](src/style.js). HTTP/CDP-клиент написан заново: нужны ограничения целей, таймауты и восстановление после перезагрузки.
- YAML-темы, запуск Slack и его специфические функции не включены.
- MIT, Copyright (c) 2024 (так указан в исходном файле). Полный текст: [лицензия](third-party/slack-themes.LICENSE.txt).

## Исследованы, без копирования кода

- [Custom UI Style](https://github.com/subframe7536/vscode-custom-ui-style/tree/60d38492c2c460df7f815f3a8394664b790adb05): изменяет установку; не подходит Snap.
- [Zap](https://github.com/hetpatel-11/Zap/tree/680826e5c1925ec008bc3571cdbcddb50052d303): подтверждает общий подход CDP, но содержит инструкции агенту вместо готового механизма автозапуска расширения.
- [VS Code](https://github.com/microsoft/vscode/tree/d2385e54099e74789556a3ab76ec6885b34b407d): исследованы поддержка строкового runtime-параметра remote-debugging-port, UI дерева и agentsWindow. Также проверены пути HTML в установленной Snap-версии 1.145.2.

## Runtime-зависимости

`ws` и `jsonc-parser` распространяются с собственными MIT-лицензиями в пакете. Версии зафиксированы в [package-lock.json](package-lock.json).
