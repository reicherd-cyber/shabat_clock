# Shabat Clock (TelTech) — line check for smart-device connectivity.
# Run on the suspect internet line:  irm https://kosher-teltech.com/linecheck.ps1 | iex
# Tests TCP reachability of the device broker (port 8883) and completes a real TLS
# handshake to detect filter-provider interception (NetFree / Etrog / Rimon style).
# English output on purpose — RTL text renders garbled in the Windows console.
$h = '188.166.29.235'; $p = 8883
Write-Host ''
Write-Host '=== Shabat Clock line check ===' -ForegroundColor Cyan
$t = Test-NetConnection $h -Port $p -WarningAction SilentlyContinue
if (-not $t.TcpTestSucceeded) {
  Write-Host "[1] Port $p : BLOCKED on this line" -ForegroundColor Red
  Write-Host "    ACTION: ask the filter provider to OPEN $h port $p" -ForegroundColor Yellow
} else {
  Write-Host "[1] Port $p : open" -ForegroundColor Green
  $tcp = $null; $ssl = $null
  try {
    $tcp = New-Object Net.Sockets.TcpClient($h, $p)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient('mqtt.kosher-teltech.com')
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
