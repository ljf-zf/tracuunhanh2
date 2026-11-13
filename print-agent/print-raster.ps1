param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)
$ErrorActionPreference = 'Stop'
function Write-Result([bool]$Ok, [string]$Message, [string]$PrinterName = '', [string]$ErrorText = '') {
  $result = [ordered]@{ ok = $Ok; message = $Message; printerName = $PrinterName; error = $ErrorText }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
}
try {
  if (-not (Test-Path -LiteralPath $PayloadPath)) { throw 'Missing raster print payload.' }
  $payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Type -AssemblyName System.Drawing
  $printerName = [string]$payload.printerName
  $settings = New-Object System.Drawing.Printing.PrinterSettings
  if ($printerName) { $settings.PrinterName = $printerName }
  if (-not $settings.IsValid) { throw "Windows printer not found: '$printerName'." }
  $resolvedPrinter = $settings.PrinterName
  $paths = @($payload.imagePaths)
  if ($paths.Count -lt 1) { throw 'No raster images to print.' }
  foreach ($p in $paths) { if (-not (Test-Path -LiteralPath ([string]$p))) { throw "Image not found: $p" } }
  $paper = $settings.PaperSizes | Where-Object { $_.PaperName -eq 'USER' } | Select-Object -First 1
  if (-not $paper) { throw 'Driver USER paper form is missing. Configure the stock in the Xprinter driver.' }
  $settings.DefaultPageSettings.PaperSize = $paper
  $settings.DefaultPageSettings.Landscape = $false
  $settings.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
  $settings.DefaultPageSettings.Color = $false
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings = $settings
  $doc.DocumentName = 'Sapo PDF raster 203 DPI - native pixel size'
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $script:index = 0
  $script:currentImage = $null
  $doc.add_PrintPage({
    param($sender, $e)
    if ($script:currentImage) { $script:currentImage.Dispose(); $script:currentImage = $null }
    $script:currentImage = New-Object System.Drawing.Bitmap([string]$paths[$script:index])
    $script:currentImage.SetResolution(203,203)
    $e.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
    $e.Graphics.DrawImageUnscaled($script:currentImage, 0, 0)
    $script:index++
    $e.HasMorePages = ($script:index -lt $paths.Count)
  })
  $doc.Print()
  if ($script:currentImage) { $script:currentImage.Dispose() }
  $doc.Dispose()
  Write-Result $true ("Submitted {0} 203-DPI raster page(s) at native pixel size." -f $paths.Count) $resolvedPrinter
} catch {
  Write-Result $false '' '' $_.Exception.Message
  exit 1
}
