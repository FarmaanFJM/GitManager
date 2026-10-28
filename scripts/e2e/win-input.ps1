# Real Windows input and screen reads for scripts/e2e-windows.mjs: what a user does with the mouse and keyboard reaches
# the window through Windows itself (hit testing, caption buttons, Snap), not through the page.
# Coordinates are physical screen pixels.
param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'click', 'dblclick', 'drag', 'snapleft', 'capture')][string]$Action,
  [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0, [int]$W = 0, [int]$H = 0,
  [string]$Path = '', [string]$Points = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class GmInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[GmInput]::SetProcessDPIAware() | Out-Null
function Move-To([double]$px, [double]$py) { [GmInput]::SetCursorPos([int][math]::Round($px), [int][math]::Round($py)) | Out-Null }
function Down { [GmInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
function Up { [GmInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
function Key([byte]$vk, [bool]$up) { [GmInput]::keybd_event($vk, 0, $(if ($up) { 2 } else { 0 }), [UIntPtr]::Zero) }

switch ($Action) {
  'move' { Move-To $X $Y }
  'click' { Move-To $X $Y; Start-Sleep -Milliseconds 200; Down; Up }
  'dblclick' { Move-To $X $Y; Start-Sleep -Milliseconds 200; Down; Up; Start-Sleep -Milliseconds 80; Down; Up }
  'drag' {
    Move-To $X $Y; Start-Sleep -Milliseconds 200; Down; Start-Sleep -Milliseconds 100
    for ($i = 1; $i -le 12; $i++) { Move-To ($X + ($X2 - $X) * $i / 12) ($Y + ($Y2 - $Y) * $i / 12); Start-Sleep -Milliseconds 40 }
    Start-Sleep -Milliseconds 150; Move-To $X2 $Y2; Start-Sleep -Milliseconds 200; Up
  }
  'snapleft' { Key 0x5B $false; Key 0x25 $false; Key 0x25 $true; Key 0x5B $true; Start-Sleep -Milliseconds 300; Key 0x1B $false; Key 0x1B $true }
  'capture' {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
    if ($Path) { $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) }
    foreach ($p in ($Points -split ';')) {
      if (-not $p) { continue }
      $xy = $p -split ','
      $c = $bmp.GetPixel([int]$xy[0], [int]$xy[1])
      '{0}={1:x2}{2:x2}{3:x2}' -f $p, $c.R, $c.G, $c.B
    }
    $g.Dispose(); $bmp.Dispose()
  }
}
