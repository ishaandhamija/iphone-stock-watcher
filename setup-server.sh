#!/bin/bash
# One-time setup on an Ubuntu server (e.g. Oracle Cloud Always Free).
# Usage: NTFY_TOPIC=your-topic bash setup-server.sh
set -euo pipefail
: "${NTFY_TOPIC:?set NTFY_TOPIC}"
DIR="$HOME/iphone-stock-watcher"

# Node 22
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

[ -d "$DIR/.git" ] || git clone https://github.com/ishaandhamija/iphone-stock-watcher.git "$DIR"
cd "$DIR" && git pull --ff-only
npm ci
sudo npx playwright install-deps chromium
npx playwright install chromium

echo "NTFY_TOPIC=$NTFY_TOPIC" > "$DIR/.env"
chmod 600 "$DIR/.env"

# systemd timer: run every 5 minutes
sudo tee /etc/systemd/system/iphone-watcher.service >/dev/null <<UNIT
[Unit]
Description=iPhone fast-delivery check
[Service]
Type=oneshot
User=$USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=/usr/bin/node $DIR/check.mjs
TimeoutStartSec=240
UNIT
sudo tee /etc/systemd/system/iphone-watcher.timer >/dev/null <<UNIT
[Unit]
Description=Run iPhone check every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now iphone-watcher.timer
echo "Installed. Logs: journalctl -u iphone-watcher -f"
