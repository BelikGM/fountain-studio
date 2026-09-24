# Запустить команду на отдельном НЕВИДИМОМ рабочем столе Windows и дождаться конца.
#
# Зачем. Проверки, которым нужно обычное окно с фокусом (ui-shot.cjs с
# "visible": true, app-test, установщик), нельзя запускать на экране человека:
# окно выскакивает поверх его работы, забирает фокус, а нажатия из проверки
# уходят в чужое приложение (так 24.09.2026 три Enter из проверки установщика
# ушли в открытую на весь экран программу). Здесь окна рисуются на своём
# рабочем столе, которого не видно, — человеку ничего не мешает.
#
# Запуск (из Git Bash или PowerShell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-hidden.ps1 `
#     -Command 'cmd /c npm run app-test > app-test.log 2>&1' -TimeoutSec 900
# Вывод команды перенаправлять в файл: консоли у невидимого стола нет.
#
# Файл сохранён в UTF-8 с BOM: без него Windows PowerShell 5 читает кириллицу
# в комментариях как кракозябры и ломается на разборе.
param([string]$Command, [int]$TimeoutSec = 600)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class HiddenDesk {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SI { public int cb; public string r; public string desk; public string title; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref SI si, out PI pi);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
}
"@
$repo = Split-Path -Parent $PSScriptRoot
$desk = [HiddenDesk]::CreateDesktop('fs-hidden-check', [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($desk -eq [IntPtr]::Zero) { Write-Output 'невидимый рабочий стол не создан'; exit 1 }
$si = New-Object HiddenDesk+SI
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$si.desk = 'fs-hidden-check'
$pi = New-Object HiddenDesk+PI
# Командная строка — изменяемый буфер: CreateProcess пишет в неё. $null вместо
# имени программы PowerShell передаёт пустой строкой, отсюда [NullString].
$sb = New-Object System.Text.StringBuilder $Command, 4096
$ok = [HiddenDesk]::CreateProcess([NullString]::Value, $sb, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, $repo, [ref]$si, [ref]$pi)
if (-not $ok) { Write-Output ('не запущено, код ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
$waited = [HiddenDesk]::WaitForSingleObject($pi.hp, [uint32]($TimeoutSec * 1000))
[HiddenDesk]::CloseDesktop($desk) | Out-Null
if ($waited -ne 0) { Write-Output "не уложилось в $TimeoutSec с"; exit 1 }
Write-Output 'готово'
