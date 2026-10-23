# Shabat Clock (TelTech) — line check for smart-device connectivity.
# Run on the suspect internet line:  irm https://kosher-teltech.com/linecheck.ps1 | iex
# Tests TCP reachability of the device broker (mqtt2.kosher-teltech.com, port 443 —
# the filter-proof address every installer file writes since 2026-10-23) and
# completes a real TLS handshake to detect filter-provider interception
# (NetFree / Etrog / Rimon style).
# English output on purpose — RTL text renders garbled in the Windows console.
$name = 'mqtt2.kosher-teltech.com'; $fallbackIp = '167.99.19.11'; $p = 443
Write-Host ''
Write-Host '=== Shabat Clock line check ===' -ForegroundColor Cyan
# [0] DNS first: a filter that sinkholes the name would otherwise read as a
# blocked port, and the provider would open the port while the name stays dead.
$h = $name
try {
  $ips = [Net.Dns]::GetHostAddresses($name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString }
  if (-not $ips -or $ips -contains '0.0.0.0' -or $ips -contains '127.0.0.1') { throw 'sinkholed' }
  Write-Host "[0] DNS $name -> $($ips -join ', ')" -ForegroundColor Green
  if ($ips -notcontains $fallbackIp) {
    Write-Host "    WARNING: expected $fallbackIp - the name resolves elsewhere on this line (filter DNS?)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "[0] DNS $name : FAILED on this line ($($_.Exception.Message))" -ForegroundColor Red
  Write-Host "    ACTION: ask the filter provider to allow the name $name (it must resolve to $fallbackIp)" -ForegroundColor Yellow
  Write-Host "    continuing the port test against $fallbackIp directly..."
  $h = $fallbackIp
}
$t = Test-NetConnection $h -Port $p -WarningAction SilentlyContinue
if (-not $t.TcpTestSucceeded) {
  Write-Host "[1] Port $p : BLOCKED on this line (target $h)" -ForegroundColor Red
  Write-Host "    ACTION: ask the filter provider to OPEN $name ($fallbackIp) port $p" -ForegroundColor Yellow
} else {
  Write-Host "[1] Port $p : open (target $h)" -ForegroundColor Green
  $tcp = $null; $ssl = $null
  try {
    $tcp = New-Object Net.Sockets.TcpClient($h, $p)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($h)
    $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    Write-Host "[2] Certificate subject : $($c.Subject)"
    Write-Host "    Certificate issuer  : $($c.Issuer)"
    if ($c.Issuer -match 'Shabat Clock Device CA') {
      Write-Host '[3] LINE IS CLEAN - devices can connect.' -ForegroundColor Green
      Write-Host '    If a device still does not connect, the problem is the device (Wi-Fi / settings), not the line.'
    } elseif ($c.Issuer -eq $c.Subject) {
      Write-Host '[3] TLS INTERCEPTION - the filter swaps the certificate; devices refuse it (as designed).' -ForegroundColor Red
      Write-Host "    ACTION: ask the filter provider to EXCLUDE $h port $p from TLS interception" -ForegroundColor Yellow
      Write-Host '            (and exclude the site kosher-teltech.com from browser filtering too)' -ForegroundColor Yellow
    } else {
      Write-Host '[3] FOREIGN certificate - most likely filter interception.' -ForegroundColor Red
      Write-Host "    ACTION: ask the filter provider to exclude $h port $p" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "[2] TLS handshake FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    The line passes TCP but breaks the encryption - ask the provider to exclude $h port $p" -ForegroundColor Yellow
  } finally {
    if ($ssl) { $ssl.Dispose() }
    if ($tcp) { $tcp.Close() }
  }
}
Write-Host '=== done ===' -ForegroundColor Cyan
