param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$ErrorActionPreference = 'Stop'

function Write-Result([bool]$Ok, [string]$Message, [string]$PrinterName = '', [string]$ErrorText = '') {
  $result = [ordered]@{ ok = $Ok; message = $Message; printerName = $PrinterName; error = $ErrorText }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
}

function Add-TextSegment([string]$Text, [string]$Style = 'normal', [int]$GapAfter = 2) {
  if ($null -eq $script:segments) { $script:segments = New-Object System.Collections.ArrayList }
  [void]$script:segments.Add([pscustomobject]@{ Text = [string]$Text; Style = $Style; GapAfter = $GapAfter })
}

function Format-Vnd($Value) {
  if ($null -eq $Value -or $Value -eq '') { return '' }
  try {
    return ('{0:N0} đ' -f [decimal]$Value)
  } catch { return [string]$Value }
}

try {
  if (-not (Test-Path -LiteralPath $PayloadPath)) { throw 'Không tìm thấy dữ liệu bill tạm.' }
  $payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $order = $payload.order
  if (-not $order -or -not $order.code) { throw 'Thiếu mã đơn hàng.' }

  Add-Type -AssemblyName System.Drawing

  $printerName = [string]$payload.settings.printerName
  $printerSettings = New-Object System.Drawing.Printing.PrinterSettings
  if ($printerName) { $printerSettings.PrinterName = $printerName }
  if (-not $printerSettings.IsValid) {
    if ($printerName) { throw "Windows không tìm thấy máy in '$printerName'. Kiểm tra driver và tên máy in." }
    throw 'Windows chưa có máy in mặc định hợp lệ. Hãy cài driver Xprinter và đặt máy in mặc định.'
  }
  $resolvedPrinter = $printerSettings.PrinterName

  $script:segments = New-Object System.Collections.ArrayList
  if ($payload.settings.shopName) { Add-TextSegment ([string]$payload.settings.shopName) 'title' 2 }
  Add-TextSegment 'PHIẾU ĐƠN HÀNG' 'title' 3
  Add-TextSegment ("Mã đơn: {0}" -f [string]$order.code) 'strong' 1
  if ($order.createdAt) {
    try { $dateText = ([datetime]$order.createdAt).ToString('dd/MM/yyyy HH:mm') }
    catch { $dateText = [string]$order.createdAt }
    Add-TextSegment ("Ngày tạo: {0}" -f $dateText) 'normal' 1
  }
  if ($order.trackingCode) { Add-TextSegment ("Mã vận đơn: {0}" -f [string]$order.trackingCode) 'normal' 1 }
  if ($order.carrier) { Add-TextSegment ("Đơn vị VC: {0}" -f [string]$order.carrier) 'normal' 3 }
  Add-TextSegment '----------------------------------------' 'small' 3
  Add-TextSegment 'THÔNG TIN NGƯỜI NHẬN' 'section' 2
  if ($order.customerName) { Add-TextSegment ([string]$order.customerName) 'strong' 1 }
  if ($order.phone) { Add-TextSegment ("Điện thoại: {0}" -f [string]$order.phone) 'normal' 1 }
  if ($order.address) { Add-TextSegment ([string]$order.address) 'normal' 3 }
  Add-TextSegment '----------------------------------------' 'small' 3
  Add-TextSegment 'SẢN PHẨM' 'section' 2

  $items = @($order.items)
  if ($items.Count -eq 0) { Add-TextSegment 'Không có chi tiết sản phẩm trong dữ liệu API.' 'normal' 2 }
  foreach ($item in $items) {
    $itemName = [string]$item.name
    if ($item.variant) { $itemName = "$itemName · $([string]$item.variant)" }
    if ($itemName) { Add-TextSegment $itemName 'strong' 1 }
    if ($item.sku) { Add-TextSegment ("SKU: {0}" -f [string]$item.sku) 'normal' 1 }
    Add-TextSegment ("Số lượng: {0}" -f [string]$item.quantity) 'normal' 2
    if ($null -ne $item.unitPrice) { Add-TextSegment ("Đơn giá: {0}" -f (Format-Vnd $item.unitPrice)) 'normal' 1 }
    if ($null -ne $item.lineTotal) { Add-TextSegment ("Thành tiền: {0}" -f (Format-Vnd $item.lineTotal)) 'normal' 2 }
  }

  Add-TextSegment '----------------------------------------' 'small' 3
  if ($order.shippingFee -ne $null) { Add-TextSegment ("Phí vận chuyển: {0}" -f (Format-Vnd $order.shippingFee)) 'normal' 1 }
  if ($order.discountAmount -ne $null) { Add-TextSegment ("Giảm giá: -{0}" -f (Format-Vnd $order.discountAmount)) 'normal' 1 }
  if ($order.totalAmount -ne $null) { Add-TextSegment ("TỔNG CỘNG: {0}" -f (Format-Vnd $order.totalAmount)) 'total' 2 }
  if ($order.paymentMethod) { Add-TextSegment ("Thanh toán: {0}" -f [string]$order.paymentMethod) 'normal' 1 }
  if ($order.codAmount -ne $null) { Add-TextSegment ("Tiền thu hộ: {0}" -f (Format-Vnd $order.codAmount)) 'strong' 2 }
  Add-TextSegment 'Cảm ơn quý khách!' 'center' 4
  Add-TextSegment ([string]$order.code) 'center' 1

  $script:segmentIndex = 0
  $document = New-Object System.Drawing.Printing.PrintDocument
  $document.PrinterSettings = $printerSettings
  $document.DocumentName = "Sapo bill $([string]$order.code)"
  $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $document.DefaultPageSettings.Landscape = $false
  $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(8, 8, 8, 8)

  $document.add_PrintPage({
    param($sender, $eventArgs)
    $graphics = $eventArgs.Graphics
    $bounds = $eventArgs.MarginBounds
    $y = [single]$bounds.Top
    while ($script:segmentIndex -lt $script:segments.Count) {
      $segment = $script:segments[$script:segmentIndex]
      switch ($segment.Style) {
        'title' { $font = New-Object System.Drawing.Font('Arial', 12, [System.Drawing.FontStyle]::Bold) }
        'section' { $font = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold) }
        'strong' { $font = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold) }
        'total' { $font = New-Object System.Drawing.Font('Arial', 10, [System.Drawing.FontStyle]::Bold) }
        'center' { $font = New-Object System.Drawing.Font('Arial', 8, [System.Drawing.FontStyle]::Bold) }
        'small' { $font = New-Object System.Drawing.Font('Arial', 7, [System.Drawing.FontStyle]::Regular) }
        default { $font = New-Object System.Drawing.Font('Arial', 8.5, [System.Drawing.FontStyle]::Regular) }
      }
      $availableHeight = [single]($bounds.Bottom - $y)
      $layout = New-Object System.Drawing.RectangleF([single]$bounds.Left, [single]$y, [single]$bounds.Width, $availableHeight)
      $format = New-Object System.Drawing.StringFormat
      if ($segment.Style -eq 'center') { $format.Alignment = [System.Drawing.StringAlignment]::Center }
      $measure = $graphics.MeasureString([string]$segment.Text, $font, $layout.Size, $format)
      if (($measure.Height + $segment.GapAfter) -gt $availableHeight -and $y -gt $bounds.Top) {
        $font.Dispose()
        $format.Dispose()
        $eventArgs.HasMorePages = $true
        return
      }
      $brush = [System.Drawing.Brushes]::Black
      $graphics.DrawString([string]$segment.Text, $font, $brush, $layout, $format)
      $y += [single]([Math]::Ceiling($measure.Height) + [int]$segment.GapAfter)
      $font.Dispose()
      $format.Dispose()
      $script:segmentIndex++
      if ($y -ge $bounds.Bottom) { break }
    }
    $eventArgs.HasMorePages = ($script:segmentIndex -lt $script:segments.Count)
  })

  $document.Print()
  $document.Dispose()
  Write-Result $true 'Windows đã tiếp nhận lệnh in.' $resolvedPrinter
} catch {
  Write-Result $false '' '' $_.Exception.Message
  exit 1
}
