# Автозапуск движка Fountain Studio при входе в Windows (планировщик задач).
# Запуск (PowerShell от имени текущего пользователя, из корня репозитория):
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
# Жёстко закрепить объект (иначе поднимается последний открытый):
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Project "C:\...\Проекты\Новороссийск"
# Удаление задачи:
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove

param([switch]$Remove, [string]$Project = '')

$taskName = 'FountainStudioEngine'

if ($Remove) {
  schtasks /Delete /TN $taskName /F
  Write-Host "Задача $taskName удалена."
  exit 0
}

$repo = Split-Path -Parent $PSScriptRoot

# Без -Project движок поднимет объект, открытый последним (он запомнен в данных
# программы). Объект указывают явно там, где на компьютере их несколько и
# фонтан должен подниматься всегда один и тот же.
$extra = ''
if ($Project -ne '') {
  if (-not (Test-Path $Project)) {
    Write-Host "Папка объекта не найдена: $Project"
    exit 1
  }
  $extra = " -- --project `"$Project`""
}
$cmd = "cmd /c cd /d `"$repo`" && npm run engine:watchdog$extra"

schtasks /Create /TN $taskName /TR $cmd /SC ONLOGON /RL LIMITED /F
if ($LASTEXITCODE -eq 0) {
  Write-Host "Готово: движок будет запускаться при входе в Windows (задача $taskName)."
  if ($Project -ne '') { Write-Host "Объект закреплён: $Project" }
  else { Write-Host 'Объект: тот, что открывали последним.' }
  Write-Host "Сторож перезапустит его при падении. Проверить сейчас: npm run engine:watchdog"
} else {
  Write-Host 'Не удалось создать задачу — запустите PowerShell от администратора.'
}
