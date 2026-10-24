# Shabat Clock (TelTech) — line check for smart-device connectivity.
# Run on the suspect internet line:  irm https://kosher-teltech.com/linecheck.ps1 | iex
# Tests the two broker addresses a device may be configured with:
#   [A] mqtt.kosher-teltech.com  port 8883 — the default every installer file writes
#       (NetFree opened it for all customers; other filters may need an exclusion)
#   [B] mqtt2.kosher-teltech.com port 443  — the alternative for lines that throttle 8883
# For each: DNS, TCP, then a real TLS handshake to detect filter-provider
# interception (NetFree / Etrog / Rimon style) — a swapped certificate.
# English output on purpose — RTL text renders garbled in the Windows console.
$targets = @(
  @{ label = 'A (default)';     name = 'mqtt.kosher-teltech.com';  ip = '188.166.29.235'; port = 8883 },
  @{ label = 'B (alternative)'; name = 'mqtt2.kosher-teltech.com'; ip = '167.99.19.11';   port = 443 }
)
Write-Host ''
Write-Host '=== Shabat Clock line check ===' -ForegroundColor Cyan
$clean = @()
foreach ($t in $targets) {
  $name = $t.name; $fallbackIp = $t.ip; $p = $t.port; $label = $t.label
  Write-Host ''
  Write-Host "--- [$label] $name port $p ---" -ForegroundColor Cyan
  # DNS first: a filter that sinkholes the name would otherwise read as a
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
  $tcp = Test-NetConnection $h -Port $p -WarningAction SilentlyContinue
  if (-not $tcp.TcpTestSucceeded) {
    Write-Host "[1] Port $p : BLOCKED on this line (target $h)" -ForegroundColor Red
    Write-Host "    ACTION: ask the filter provider to OPEN $name ($fallbackIp) port $p" -ForegroundColor Yellow
    continue
  }
  Write-Host "[1] Port $p : open (target $h)" -ForegroundColor Green
  $sock = $null; $ssl = $null
  try {
    $sock = New-Object Net.Sockets.TcpClient($h, $p)
    $ssl = New-Object Net.Security.SslStream($sock.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($h)
    $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    Write-Host "[2] Certificate subject : $($c.Subject)"
    Write-Host "    Certificate issuer  : $($c.Issuer)"
    if ($c.Issuer -match 'Shabat Clock Device CA' -and $h -ne $name) {
      # Reached by IP only: the name is dead on this line, and devices dial the name.
      Write-Host "[3] Server answers by IP with our certificate, but $name does not resolve here." -ForegroundColor Yellow
      Write-Host "    Devices dial the NAME, so this address is NOT usable until the provider fixes DNS." -ForegroundColor Yellow
    } elseif ($c.Issuer -match 'Shabat Clock Device CA') {
      Write-Host "[3] CLEAN - devices configured for $name port $p can connect." -ForegroundColor Green
      $clean += "$name port $p"
    } elseif ($c.Issuer -eq $c.Subject) {
      Write-Host '[3] TLS INTERCEPTION - the filter swaps the certificate; devices refuse it (as designed).' -ForegroundColor Red
      Write-Host "    ACTION: ask the filter provider to EXCLUDE $name ($fallbackIp) port $p from TLS interception" -ForegroundColor Yellow
    } else {
      Write-Host '[3] FOREIGN certificate - most likely filter interception.' -ForegroundColor Red
      Write-Host "    ACTION: ask the filter provider to exclude $name ($fallbackIp) port $p" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "[2] TLS handshake FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    The line passes TCP but breaks the encryption - ask the provider to exclude $name ($fallbackIp) port $p" -ForegroundColor Yellow
  } finally {
    if ($ssl) { $ssl.Dispose() }
    if ($sock) { $sock.Close() }
  }
}
Write-Host ''
if ($clean.Count -eq 2) {
  Write-Host 'RESULT: LINE IS CLEAN on both addresses.' -ForegroundColor Green
  Write-Host '        If a device still does not connect, the problem is the device (Wi-Fi / settings), not the line.'
} elseif ($clean.Count -eq 1) {
  Write-Host "RESULT: only $($clean[0]) is clean on this line." -ForegroundColor Yellow
  Write-Host '        A device configured for the other address needs a new installer file for this one,'
  Write-Host '        or an exclusion from the filter provider as written above.'
} else {
  Write-Host 'RESULT: NEITHER address passes - devices cannot connect from this line until the provider acts.' -ForegroundColor Red
  Write-Host '        Also ask them to exclude the site kosher-teltech.com from browser filtering.'
}
Write-Host '=== done ===' -ForegroundColor Cyan
