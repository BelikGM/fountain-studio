# Снимок окна программы целиком (с кнопками Windows в строке заголовка) — PrintWindow.
# Запускается на том же невидимом рабочем столе, что и программа (packages/engine/src/tools/app-shots.ts):
# EnumWindows видит только окна своего рабочего стола — чужие окна человека не попадут.
# -Resize 900x640 — сначала поменять размер окна (как если бы человек потянул за край).
param([string]$Out, [string]$Resize)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  public static IntPtr Biggest(uint[] pids) {
    IntPtr best = IntPtr.Zero; int area = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r); int a = (r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
# Окно рисует один из процессов Electron — берём всё дерево процессов по имени.
$pids = @(Get-Process -Name electron -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
$h = [PW]::Biggest($pids)
if ($h -eq [IntPtr]::Zero) { Write-Output 'окно не найдено'; exit 1 }
if ($Resize) {
  $wh = $Resize.Split("x")
  [PW]::MoveWindow($h, 0, 0, [int]$wh[0], [int]$wh[1], $true) | Out-Null
  if (-not $Out) { Write-Output ("размер " + $Resize); exit 0 }
  Start-Sleep -Milliseconds 800
}
$r = New-Object PW+RECT
[PW]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc(); [PW]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$bmp.Save($Out)
Write-Output ('снято ' + ($r.R - $r.L) + 'x' + ($r.B - $r.T))
