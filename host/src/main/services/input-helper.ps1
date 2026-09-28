# Mini Host input helper — persistent JSON-lines service over stdin/stdout.
# One JSON request per line, one JSON response per line. Windows only.
# -WaitClick 模式:执行一次全局点击等待后退出(独立进程,不占用点击链)。

param([switch]$WaitClick)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class MiniInput {
  public static bool DpiReady = false;
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAware();
  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int value);

  // 进程级 DPI 感知:必须开启,否则本进程的坐标全部运行在主屏虚拟化
  // DIP 空间,SetCursorPos/SendInput/GetCursorPos 都会偏离物理位置
  // (等价于旧版连连看的 ensure_dpi_aware)
  public static bool EnableDpiAwareness() {
    try {
      // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
      if (SetProcessDpiAwarenessContext((IntPtr)(-4))) return true;
    } catch {}
    try {
      if (SetProcessDpiAwareness(2) == 0) return true; // PER_MONITOR_AWARE
    } catch {}
    return SetProcessDpiAware();
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy;
    public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public INPUTUNION u;
  }

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const int INPUT_MOUSE = 0;
  public const int INPUT_KEYBOARD = 1;

  public static uint SendMouse(uint flags) {
    var arr = new INPUT[1];
    arr[0].type = INPUT_MOUSE;
    arr[0].u.mi.dwFlags = flags;
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendKey(ushort vk, bool up) {
    var arr = new INPUT[1];
    arr[0].type = INPUT_KEYBOARD;
    arr[0].u.ki.wVk = vk;
    if (up) arr[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendChar(char c, bool up) {
    var arr = new INPUT[1];
    arr[0].type = INPUT_KEYBOARD;
    arr[0].u.ki.wScan = c;
    arr[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

function Get-Vk([string]$name) {
  $n = $name.Trim().ToLower()
  switch ($n) {
    "ctrl" { return 0x11 } "control" { return 0x11 } "shift" { return 0x10 }
    "alt" { return 0x12 } "menu" { return 0x12 }
    "win" { return 0x5B } "meta" { return 0x5B } "cmd" { return 0x5B }
    "enter" { return 0x0D } "return" { return 0x0D }
    "esc" { return 0x1B } "escape" { return 0x1B }
    "space" { return 0x20 } "tab" { return 0x09 }
    "backspace" { return 0x08 } "delete" { return 0x2E } "del" { return 0x2E }
    "insert" { return 0x2D } "ins" { return 0x2D }
    "home" { return 0x24 } "end" { return 0x23 }
    "pageup" { return 0x21 } "pgup" { return 0x21 }
    "pagedown" { return 0x22 } "pgdn" { return 0x22 }
    "up" { return 0x26 } "down" { return 0x28 } "left" { return 0x25 } "right" { return 0x27 }
  }
  if ($n -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0x6F + [int]$Matches[1] }
  if ($n -match '^[a-z]$') { return [byte][char]::ToUpperInvariant($n[0]) }
  if ($n -match '^[0-9]$') { return 0x30 + [int]$n }
  throw "unknown key: $name"
}

# 进程级 DPI 感知:必须在任何窗口/坐标操作之前开启(等价旧版 ensure_dpi_aware)
[void][MiniInput]::EnableDpiAwareness()

function Send-Click([string]$button) {
  if ($button -eq "right") {
    [void][MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_RIGHTDOWN)
    Start-Sleep -Milliseconds 15
    [void][MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_RIGHTUP)
  } else {
    [void][MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_LEFTDOWN)
    Start-Sleep -Milliseconds 15
    [void][MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_LEFTUP)
  }
}

function Wait-GlobalClick {
  # 全局等待一次左键点击(真实屏幕物理坐标,零转换)。
  # 忽略调用时仍按着的键;Esc 取消;默认 90 秒超时。
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  $timedOut = $false
  $cancelled = $false
  while (([MiniInput]::GetAsyncKeyState(1) -band 0x8000) -ne 0) {
    if (([MiniInput]::GetAsyncKeyState(27) -band 0x8000) -ne 0) { $cancelled = $true; break }
    if ([DateTime]::UtcNow -gt $deadline) { $timedOut = $true; break }
    Start-Sleep -Milliseconds 25
  }
  if (-not $timedOut -and -not $cancelled) {
    while (([MiniInput]::GetAsyncKeyState(1) -band 0x8000) -eq 0) {
      if (([MiniInput]::GetAsyncKeyState(27) -band 0x8000) -ne 0) { $cancelled = $true; break }
      if ([DateTime]::UtcNow -gt $deadline) { $timedOut = $true; break }
      Start-Sleep -Milliseconds 25
    }
  }
  if (-not $timedOut -and -not $cancelled) {
    while (([MiniInput]::GetAsyncKeyState(1) -band 0x8000) -ne 0) {
      if ([DateTime]::UtcNow -gt $deadline) { $timedOut = $true; break }
      Start-Sleep -Milliseconds 25
    }
    $p = New-Object MiniInput+POINT
    [void][MiniInput]::GetCursorPos([ref]$p)
    return @{ x = $p.X; y = $p.Y }
  }
  if ($cancelled) { return @{ cancelled = $true } }
  return @{ timeout = $true }
}

if ($WaitClick) {
  [Console]::Out.WriteLine((@{ ok = $true; result = (Wait-GlobalClick) } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  exit 0
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $req = $line | ConvertFrom-Json
    $result = $null
    switch ($req.op) {
      "position" {
        $p = New-Object MiniInput+POINT
        [void][MiniInput]::GetCursorPos([ref]$p)
        $result = @{ x = $p.X; y = $p.Y }
      }
      "wait-click" {
        $result = Wait-GlobalClick
      }
      "move" {
        $okMove = [MiniInput]::SetCursorPos([int]$req.x, [int]$req.y)
        $p = New-Object MiniInput+POINT
        [void][MiniInput]::GetCursorPos([ref]$p)
        $diag = @{ setCursorPos = [bool]$okMove; cursor = @{ x = $p.X; y = $p.Y } }
      }
      "click" {
        $okMove = [MiniInput]::SetCursorPos([int]$req.x, [int]$req.y)
        Start-Sleep -Milliseconds 15
        $p = New-Object MiniInput+POINT
        [void][MiniInput]::GetCursorPos([ref]$p)
        $down = 0; $up = 0
        if ($req.button -eq "right") {
          $down = [MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_RIGHTDOWN)
          Start-Sleep -Milliseconds 15
          $up = [MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_RIGHTUP)
        } else {
          $down = [MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_LEFTDOWN)
          Start-Sleep -Milliseconds 15
          $up = [MiniInput]::SendMouse([MiniInput]::MOUSEEVENTF_LEFTUP)
        }
        $diag = @{
          setCursorPos = [bool]$okMove
          cursor = @{ x = $p.X; y = $p.Y }
          sendInput = @($down, $up)
        }
      }
      "dblclick" {
        [void][MiniInput]::SetCursorPos([int]$req.x, [int]$req.y)
        Start-Sleep -Milliseconds 15
        Send-Click "left"
        Start-Sleep -Milliseconds 40
        Send-Click "left"
      }
      "press" {
        $vk = Get-Vk ([string]$req.key)
        [void][MiniInput]::SendKey([uint16]$vk, $false)
        Start-Sleep -Milliseconds 15
        [void][MiniInput]::SendKey([uint16]$vk, $true)
      }
      "hotkey" {
        $vks = @($req.keys | ForEach-Object { Get-Vk ([string]$_) })
        foreach ($vk in $vks) {
          [void][MiniInput]::SendKey([uint16]$vk, $false)
          Start-Sleep -Milliseconds 10
        }
        Start-Sleep -Milliseconds 30
        for ($i = $vks.Length - 1; $i -ge 0; $i--) {
          [void][MiniInput]::SendKey([uint16]$vks[$i], $true)
          Start-Sleep -Milliseconds 10
        }
      }
      "type" {
        foreach ($ch in ([string]$req.text).ToCharArray()) {
          [void][MiniInput]::SendChar($ch, $false)
          [void][MiniInput]::SendChar($ch, $true)
        }
      }
      default { throw "unknown op: $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ ok = $true; result = $result; diag = $diag } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
