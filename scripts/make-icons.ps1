# 확장 아이콘(16/32/48/128 PNG)과 웹스토어용 아이콘(128, 그림 96 + 투명 여백 16)을 그린다.
# Windows 기본 System.Drawing 만 사용.
# 사용: powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot '..'
$iconDir = Join-Path $root 'icons'
$storeDir = Join-Path $root 'store\images'
New-Item -ItemType Directory -Force $iconDir, $storeDir | Out-Null

function New-RoundedPath([single]$size, [single]$radius) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 원점(0,0)에 한 변 $s 크기로 아이콘을 그린다
function Draw-Icon($g, [single]$s) {
  # 배경: 파란 둥근 사각형(달력 한 장)
  $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 57, 135, 229), [System.Drawing.Color]::FromArgb(255, 28, 92, 171), [single]60)
  $path = New-RoundedPath $s ([single]($s * 0.22))
  $g.FillPath($bg, $path)

  # 달력 머리띠 + 고리(32px 이상에서만)
  if ($s -ge 32) {
    $g.SetClip($path)
    $band = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 255, 255, 255))
    $g.FillRectangle($band, [single]0, [single]0, $s, [single]($s * 0.27))
    $g.ResetClip()
    $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $rw = $s * 0.08; $rh = $s * 0.15; $ry = $s * 0.05
    foreach ($cx in ($s * 0.32), ($s * 0.68)) {
      $g.FillRectangle($ring, [single]($cx - $rw / 2), [single]$ry, [single]$rw, [single]$rh)
    }
  }

  # 체크 표시
  $penW = [single]([Math]::Max(2.2, $s * 0.12))
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $penW
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $yOff = if ($s -ge 32) { $s * 0.08 } else { 0 }
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ([single]($s * 0.27)), ([single]($s * 0.52 + $yOff))),
    (New-Object System.Drawing.PointF ([single]($s * 0.44)), ([single]($s * 0.69 + $yOff))),
    (New-Object System.Drawing.PointF ([single]($s * 0.74)), ([single]($s * 0.37 + $yOff)))
  )
  $g.DrawLines($pen, $pts)
}

# 캔버스 $canvas 크기 PNG 에 $art 크기 그림을 가운데 둔다
function Save-Icon([int]$canvas, [single]$art, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $off = ($canvas - $art) / 2
  $g.TranslateTransform([single]$off, [single]$off)
  Draw-Icon $g $art
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved $file"
}

foreach ($size in 16, 32, 48, 128) {
  Save-Icon $size ([single]$size) (Join-Path $iconDir "icon$size.png")
}
# 웹스토어 아이콘 권장 규격: 128x128 캔버스, 그림 96x96, 사방 16px 투명 여백
Save-Icon 128 ([single]96) (Join-Path $storeDir 'icon-store-128.png')
