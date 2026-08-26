# make-icon.ps1 — generate the app / tray icons under build/.
# Uses System.Drawing (always available on Windows PowerShell). Outputs:
#   build/icon.ico   (256x256, for electron-builder / Windows)
#   build/icon.png   (256x256, preview)
#   build/tray.png   (32x32, tray)
param(
  [string]$OutDir = (Join-Path $PSScriptRoot "..\build")
)

Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-DshBitmap {
  param([int]$Size)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-rect gradient background (deep blue).
  $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $radius = [Math]::Max(2, [int]($Size * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 23, 62, 120),
    [System.Drawing.Color]::FromArgb(255, 12, 24, 48),
    45.0)
  $g.FillPath($brush, $path)

  # "DSH" monogram, centered with a RectangleF layout + StringFormat.
  $fontSize = [Math]::Max(6, [int]($Size * 0.38))
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $layout = [System.Drawing.RectangleF]::new(0, 0, [single]$Size, [single]$Size)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString([string]"DSH", $font, [System.Drawing.Brushes]::White, $layout, $sf)

  $g.Dispose()
  return $bmp
}

function Save-Png {
  param($bmp, [string]$Path)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# 256x256 ICO (single size is accepted by electron-builder for Windows).
$icon256 = New-DshBitmap -Size 256
Save-Png -bmp $icon256 -Path (Join-Path $OutDir "icon.png")
$hIcon = $icon256.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create((Join-Path $OutDir "icon.ico"))
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
try { [System.Runtime.InteropServices.Marshal]::DestroyIcon($hIcon) } catch { }
$icon256.Dispose()

# 32x32 tray icon (shipped inside the app, so it lives in assets/, not build/).
$tray = New-DshBitmap -Size 32
Save-Png -bmp $tray -Path (Join-Path $OutDir "tray.png")
$assetsDir = (Join-Path $PSScriptRoot "..\assets")
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
Save-Png -bmp $tray -Path (Join-Path $assetsDir "tray.png")
$tray.Dispose()

Write-Output "Icons written to $OutDir and $assetsDir"
