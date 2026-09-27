$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'assets\branding\logo-original.png'
$outputDirectory = Join-Path $projectRoot 'assets\icons'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

# Resize the supplied artwork without cropping or changing its composition.
$sourceImage = [Drawing.Image]::FromFile($sourcePath)
try {
    foreach ($size in @(16, 24, 32, 48, 64, 96, 128, 256, 512)) {
        $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $attributes = [Drawing.Imaging.ImageAttributes]::new()
        try {
            $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $attributes.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
            $width = [Math]::Max(1, [int][Math]::Round($sourceImage.Width * $scale))
            $height = [Math]::Max(1, [int][Math]::Round($sourceImage.Height * $scale))
            $rectangle = [Drawing.Rectangle]::new(
                [int][Math]::Floor(($size - $width) / 2),
                [int][Math]::Floor(($size - $height) / 2), $width, $height
            )
            $graphics.DrawImage($sourceImage, $rectangle, 0, 0, $sourceImage.Width, $sourceImage.Height,
                [Drawing.GraphicsUnit]::Pixel, $attributes)
            $bitmap.Save((Join-Path $outputDirectory "icon-$size.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $attributes.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $sourceImage.Dispose()
}

Write-Output 'Exported PNG icons: 16, 24, 32, 48, 64, 96, 128, 256, 512 pixels.'
