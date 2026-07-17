# Автозапуск движка Fountain Studio при входе в Windows (планировщик задач).
# Запуск (PowerShell от имени текущего пользователя, из корня репозитория):
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
# Удаление задачи:
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove

param([switch]$Remove)

$taskName = 'FountainStudioEngine'

if ($Remove) {
  schtasks /Delete /TN $taskName /F
  Write-Host "Задача $taskName удалена."
  exit 0
}

$repo = Split-Path -Parent $PSScriptRoot
$cmd = "cmd /c cd /d `"$repo`" && npm run engine:watchdog"

schtasks /Create /TN $taskName /TR $cmd /SC ONLOGON /RL LIMITED /F
if ($LASTEXITCODE -eq 0) {
  Write-Host "Готово: движок будет запускаться при входе в Windows (задача $taskName)."
  Write-Host "Сторож перезапустит его при падении. Проверить сейчас: npm run engine:watchdog"
} else {
  Write-Host 'Не удалось создать задачу — запустите PowerShell от администратора.'
}
