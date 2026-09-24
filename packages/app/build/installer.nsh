; Оформление установщика Fountain Studio.
;
; Заказчик 24.09.2026: установщик выглядел «как будто ставится очень старое
; приложение», а после первой переделки — «середина страниц осталась
; системной, надо всё своё: все экраны и все полосы загрузки».
;
; Что здесь:
;  · цвета тёмной темы редактора на ВСЕХ страницах установки и удаления:
;    фон, подписи, группы, поле папки, журнал установки; кнопки — в тёмной
;    теме Windows; заголовок окна — тёмный;
;  · полоса установки — цветом программы;
;  · страница приветствия с логотипом (installerSidebar.bmp), шапка страниц с
;    логотипом (installerHeader.bmp) — картинки рисует
;    scripts/make-brand-assets.cjs;
;  · страница «для всех пользователей или только для меня» не показывается:
;    программа ставится «только для меня» (так и было по умолчанию, прав
;    администратора не нужно), а лишняя страница с системными переключателями
;    только путала.
;
; Сборщик подключает этот файл ДО Modern UI, поэтому общие настройки ниже
; действуют на все страницы. Свои обработчики показа страниц вставляются через
; входы сборщика: customWelcomePage, customPageAfterChangeDir,
; customFinishPage, customUnWelcomePage, customUninstallPage.
; Файл — в UTF-8 с BOM: без BOM NSIS читает кириллицу как ANSI.

!include LogicLib.nsh
!include WinMessages.nsh

!define FS_BG "1E2230"
!define FS_FIELD "262B3A"
!define FS_FG "E8EAF0"
; Цвета для сообщений Windows — в порядке 0x00BBGGRR.
!define FS_BAR_COLOR 0x00FFA34A
!define FS_BAR_BACK 0x001C1512

!define MUI_BGCOLOR "${FS_BG}"
!define MUI_TEXTCOLOR "FFFFFF"
!define MUI_INSTFILESPAGE_COLORS "E8EAF0 12151C"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT fsGuiInit
!else
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.fsGuiInit
!endif

; ── Перекраска окна и его содержимого ───────────────────────────────────
; Для установщика и для удаления функции нужны каждая со своей приставкой
; («un.» — у удаления), поэтому они собраны в макрос.
!macro FS_DARK_FUNCTIONS P
  ; Перекрасить окно (со стека) и всех его прямых потомков.
  Function ${P}fsDarken
    Exch $R9
    Push $R0
    Push $R1
    Push $R2
    SetCtlColors $R9 ${FS_FG} ${FS_BG}
    StrCpy $R0 0
    ${Do}
      FindWindow $R0 "" "" $R9 $R0
      ${If} $R0 == 0
        ${Break}
      ${EndIf}
      System::Call 'user32::GetClassNameW(p R0, w .R1, i 64) i'
      ${If} $R1 == "Static"
        SetCtlColors $R0 ${FS_FG} ${FS_BG}
      ${ElseIf} $R1 == "Edit"
        SetCtlColors $R0 ${FS_FG} ${FS_FIELD}
        System::Call 'uxtheme::SetWindowTheme(p R0, w "DarkMode_CFD", p 0)'
      ${ElseIf} $R1 == "Button"
        System::Call 'user32::GetWindowLongW(p R0, i -16) i .R2'
        IntOp $R2 $R2 & 0xF
        ${If} $R2 <= 1
          ; Обычная кнопка — тёмная тема Windows.
          System::Call 'uxtheme::SetWindowTheme(p R0, w "DarkMode_Explorer", p 0)'
        ${Else}
          ; Флажок, переключатель, рамка группы: с темой Windows их подпись
          ; всегда чёрная — на тёмном фоне её не видно. Без темы подпись
          ; берёт наши цвета.
          System::Call 'uxtheme::SetWindowTheme(p R0, w " ", w " ")'
          SetCtlColors $R0 ${FS_FG} ${FS_BG}
        ${EndIf}
      ${ElseIf} $R1 == "msctls_progress32"
        ; Полоса установки: без темы Windows она берёт наши цвета.
        System::Call 'uxtheme::SetWindowTheme(p R0, w " ", w " ")'
        SendMessage $R0 0x0409 0 ${FS_BAR_COLOR}
        SendMessage $R0 0x2001 0 ${FS_BAR_BACK}
      ${ElseIf} $R1 == "SysListView32"
        System::Call 'uxtheme::SetWindowTheme(p R0, w "DarkMode_Explorer", p 0)'
      ${EndIf}
    ${Loop}
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $R9
  FunctionEnd

  ; Внешнее окно: рамка, нижняя полоса с кнопками, тёмный заголовок окна.
  Function ${P}fsGuiInit
    ; Тёмный заголовок окна (Windows 10 20H1+ и 11; на старых — без изменений).
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    Push $HWNDPARENT
    Call ${P}fsDarken
  FunctionEnd

  ; Страница: перекрасить её внутреннее окно после показа.
  Function ${P}fsPageShow
    Push $0
    FindWindow $0 "#32770" "" $HWNDPARENT
    Push $0
    Call ${P}fsDarken
    Pop $0
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro FS_DARK_FUNCTIONS ""
!else
  !insertmacro FS_DARK_FUNCTIONS "un."
!endif

; Сразу «только для меня» — страница выбора не показывается (см. шапку).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; ── Установка ────────────────────────────────────────────────────────────
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Fountain Studio"
  !define MUI_WELCOMEPAGE_TEXT "Программа управления светомузыкальными фонтанами: вывод DMX, шоу под музыку, расписание, 3D-вид струй и света.$\r$\n$\r$\nМастер установит Fountain Studio на этот компьютер. Проекты фонтанов и настройки при обновлении программы сохраняются.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !insertmacro MUI_PAGE_WELCOME
  ; Следующая страница Modern UI — выбор папки: перекрашиваем при показе.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW fsPageShow
!macroend

; После выбора папки, перед установкой — для страницы хода установки.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW fsPageShow
!macroend

; Последняя страница — как у сборщика (флажок «Запустить»), плюс перекраска:
; без неё подпись флажка на тёмном фоне была бы чёрной и невидимой.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  ; Свой текст: в стандартном у NSIS пропущен пробел («"Готово"для») и
  ; прямые кавычки вместо «ёлочек», как везде в программе.
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} установлена.$\r$\n$\r$\nНажмите «Готово», чтобы закрыть мастер."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW fsPageShow
  !insertmacro MUI_PAGE_FINISH
!macroend

; ── Удаление ─────────────────────────────────────────────────────────────
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "Мастер удалит ${PRODUCT_NAME} с этого компьютера. Проекты фонтанов и настройки программы останутся на месте — после повторной установки всё откроется как было.$\r$\n$\r$\nПеред удалением закройте программу: значок у часов → «Остановить фонтан и выйти».$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.fsPageShow
  !insertmacro MUI_UNPAGE_WELCOME
  ; Следующая страница Modern UI — ход удаления.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.fsPageShow
!macroend

; После хода удаления — для последней страницы.
!macro customUninstallPage
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} удалена с этого компьютера. Проекты фонтанов и настройки остались на месте.$\r$\n$\r$\nНажмите «Готово», чтобы закрыть мастер."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.fsPageShow
!macroend

; Удаление программы убирает и её запись в автозагрузке Windows — иначе там
; оставалась ссылка на несуществующий файл (найдено 24.09.2026). При
; ОБНОВЛЕНИИ сборщик тоже запускает удаление старой версии — тогда запись не
; трогаем, иначе после каждого обновления автозапуск пропадал бы.
; Имя записи — как в packages/engine/src/autostart.ts (runName).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FountainStudio"
  ${endIf}
!macroend
