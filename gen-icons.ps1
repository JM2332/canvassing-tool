Add-Type -AssemblyName System.Drawing

# Classic map-pin/location-marker glyph, hand-drawn (not text) — a filled
# teardrop (circle head + triangular tail) with a punched-out hole in the
# head, matching staff-holiday-tracker's approach of a drawn icon glyph
# rather than initials, so the three KML apps' home-screen icons are each
# visually distinct at a glance.

function New-Icon($size, $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $bg = [System.Drawing.ColorTranslator]::FromHtml("#1C3A2B")
  $fg = [System.Drawing.ColorTranslator]::FromHtml("#CDDC5C")

  $radius = [int]($size * 0.22)
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $bgPath.AddArc(0, 0, $d, $d, 180, 90)
  $bgPath.AddArc($size - $d, 0, $d, $d, 270, 90)
  $bgPath.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $bgPath.AddArc(0, $size - $d, $d, $d, 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($bgBrush, $bgPath)

  $cx = $size * 0.5
  $headCy = $size * 0.40
  $headR = $size * 0.165

  $fgBrush = New-Object System.Drawing.SolidBrush($fg)

  # Fill the tail first, well inside the circle's radius, then fill the
  # circle on top — the circle's opaque fill fully covers the tail's
  # internal top edge, so there's no seam between two separately
  # antialiased edges (which is what a single Winding-mode path with
  # overlapping subpaths still showed, a known GDI+ AA quirk).
  $tailApexY = $size * 0.80
  $tailBaseY = $headCy + ($headR * 0.55)
  $tailHalfW = $headR * 0.62
  $tri = @(
    [System.Drawing.PointF]::new(($cx - $tailHalfW), $tailBaseY),
    [System.Drawing.PointF]::new($cx, $tailApexY),
    [System.Drawing.PointF]::new(($cx + $tailHalfW), $tailBaseY)
  )
  $g.FillPolygon($fgBrush, $tri)
  $g.FillEllipse($fgBrush, $cx - $headR, $headCy - $headR, $headR * 2, $headR * 2)

  # punched-out hole in the head, in the background colour, for the
  # familiar "pin with a hole" silhouette
  $holeR = $headR * 0.42
  $bgHoleBrush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillEllipse($bgHoleBrush, $cx - $holeR, $headCy - $holeR, $holeR * 2, $holeR * 2)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon 192 "C:\Users\jakem\projects\canvassing-tool\icon-192.png"
New-Icon 512 "C:\Users\jakem\projects\canvassing-tool\icon-512.png"
New-Icon 180 "C:\Users\jakem\projects\canvassing-tool\apple-touch-icon.png"

Write-Host "Icons generated."
