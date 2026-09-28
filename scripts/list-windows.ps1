Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum2 {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);
  public struct RECT { public int L, T, R, B; }
  public static List<string> Scan(HashSet<int> pids) {
    var results = new List<string>();
    EnumWindows((hwnd, lp) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pids.Contains((int)pid)) {
        RECT r; GetWindowRect(hwnd, out r);
        var sb = new StringBuilder(256); GetWindowTextW(hwnd, sb, 256);
        results.Add(string.Format("pid={0} hwnd={1} visible={2} rect=({3},{4})-({5},{6}) title='{7}'", pid, hwnd, IsWindowVisible(hwnd), r.L, r.T, r.R, r.B, sb));
      }
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
'@
$pids = New-Object "System.Collections.Generic.HashSet[int]"
(Get-Process electron -ErrorAction SilentlyContinue).Id | ForEach-Object { $pids.Add($_) | Out-Null }
[WinEnum2]::Scan($pids) | ForEach-Object { Write-Output $_ }
