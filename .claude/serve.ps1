param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = $ctx.Request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
    $path = Join-Path $root $rel
    if (Test-Path $path -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      switch ($ext) {
        '.html' { $ct = 'text/html; charset=utf-8' }
        '.js'   { $ct = 'application/javascript' }
        '.css'  { $ct = 'text/css' }
        '.json' { $ct = 'application/json' }
        default { $ct = 'application/octet-stream' }
      }
      $ctx.Response.ContentType = $ct
      # Kein Browser-Caching: lokale Edits sollen nach Reload sofort sichtbar sein
      $ctx.Response.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      $ctx.Response.Headers.Add('Pragma', 'no-cache')
      $ctx.Response.Headers.Add('Expires', '0')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.OutputStream.Close()
  } catch { }
}
