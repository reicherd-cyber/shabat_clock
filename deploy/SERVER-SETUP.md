# One-time droplet setup

Everything here happens **once**, over SSH on the droplet. After this, every push to
`master` deploys automatically via GitHub Actions (`.github/workflows/deploy.yml`).

## 1. Prerequisites (skip what's already installed)

```bash
# Node.js 20 LTS + git + pm2 (ivr-collector droplet likely has these already)
node -v || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs)
sudo apt install -y git
npm ls -g pm2 >/dev/null 2>&1 || sudo npm install -g pm2
```

## 2. Clone the app

```bash
sudo mkdir -p /opt/shabat_clock && sudo chown "$USER" /opt/shabat_clock
git clone https://github.com/reicherd-cyber/shabat_clock /opt/shabat_clock
cd /opt/shabat_clock
```

## 3. Database CA certificate

Download the cluster CA from the DO panel (Databases → cluster → Connection details →
**Download CA certificate**) and place it at `/opt/shabat_clock/ca-certificate.crt`
(easiest: open it locally and `scp ca-certificate.crt <user>@<droplet>:/opt/shabat_clock/`).

## 4. Create `.env` (never committed)

```bash
cp .env.example .env && nano .env
```

Set at minimum:

```ini
NODE_ENV=production
PORT=3001
DATABASE_URL=mysql://doadmin:<password>@db-mysql-ams3-12274-do-user-32794920-0.l.db.ondigitalocean.com:25060/shabat_clock?ssl={"rejectUnauthorized":true}
DB_CA_CERT_FILE=/opt/shabat_clock/ca-certificate.crt
IVR_TOKEN=<same token configured in the Yemot api_link>
JWT_SECRET=<fresh random hex, e.g. openssl rand -hex 32>
MQTT_URL=mqtt://localhost:1883
MQTT_SERVER_USER=server
MQTT_SERVER_PASS=<broker password>
OTP_YEMOT_TOKEN=<Yemot API token — blank = OTP codes only printed to logs>
OTP_YEMOT_CALLER_ID=043131481
SMTP_HOST=... SMTP_PORT=... SMTP_USER=... SMTP_PASS=... SMTP_FROM=...
```

The DB cluster's **Trusted Sources** must include this droplet (add it by name in the
DO panel — already done). Local MySQL is NOT needed on the droplet; the app uses the
managed cluster. Mosquitto for devices is a separate concern (SPEC §5) — the app runs
fine without it (device commands report offline until the broker is up).

## 5. First deploy + PM2 boot persistence

```bash
bash deploy/deploy.sh
pm2 startup   # follow the printed sudo command once, so pm2 survives reboots
pm2 save
```

## 6. GitHub Actions secrets

Generate a dedicated deploy key on the droplet:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -N "" -C "github-actions-deploy"
cat ~/.ssh/gh_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/gh_deploy      # private key — goes into the GitHub secret, nowhere else
```

In GitHub → repo → Settings → Secrets and variables → Actions, add:

| Secret            | Value                          |
|-------------------|--------------------------------|
| `DROPLET_HOST`    | droplet IP or hostname         |
| `DROPLET_USER`    | SSH username (e.g. `root`)     |
| `DROPLET_SSH_KEY` | contents of `~/.ssh/gh_deploy` |

## 7. Expose to the internet (nginx + HTTPS)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/shabat_clock >/dev/null <<'EOF'
server {
    server_name <your-domain>;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/shabat_clock /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <your-domain>
```

## 8. Point Yemot at production

Update the Yemot root extension's `api_link` to
`https://<your-domain>/ivr/<IVR_TOKEN>` (replaces the temporary trycloudflare URL).

## Passkeys (fingerprint / Face ID login to the admin panel, 2026-11-05)

`services/passkeys.js` + `@simplewebauthn`. The relying party is the host of `PUBLIC_URL`
(`https://kosher-teltech.com` by default), so **staging needs `PUBLIC_URL=https://dev.kosher-teltech.com`
in its .env** or its passkeys will not verify. An admin registers a key from the admins page
(a current 2FA code is required when 2FA is on); the login page offers "כניסה בטביעת אצבע".
Tables: `admin_passkeys` (public keys only), `admin_passkey_challenges` (5 minutes, single use).
A failed passkey login (a credential that was checked and rejected) counts as an admin login
failure for the guardian; an aged-out challenge does not. A passkey is a complete sign-in by default (the
panel trusts the same Google account through "Sign in with Google" with no app code anyway). The
setting `security.passkey_synced_needs_2fa = 1` makes a **synced** passkey (iCloud / Google Password
Manager) on an account with the authenticator app enrolled owe the app's code: the login then
answers `twofa_required` with a five-minute ticket that only `/admin/auth/passkey-2fa` accepts.
