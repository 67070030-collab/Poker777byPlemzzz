#!/usr/bin/env bash
# Poker777 — one-shot bootstrap for a fresh Amazon Linux 2023 EC2 (Learner Lab).
# Installs Docker + the compose plugin, clones the repo, and brings the stack up.
#
# Usage (after SSH / Session Manager into the instance):
#   curl -fsSL https://raw.githubusercontent.com/getzaa456/Poker777/main/deploy/ec2-bootstrap.sh | bash
# or copy this file up and run:  bash ec2-bootstrap.sh
#
# If the GitHub repo is PRIVATE, clone will fail — either make it public, or
# clone with a token:  git clone https://<TOKEN>@github.com/getzaa456/Poker777.git
set -euo pipefail

REPO_URL="https://github.com/67070030-collab/Poker777byPlemzzz.git"
APP_DIR="$HOME/Poker777"

echo "==> Installing Docker + git…"
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

echo "==> Installing docker compose plugin…"
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

echo "==> Fetching the code…"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Building & starting the stack…"
cd "$APP_DIR"
sudo docker compose -f docker-compose.prod.yml up -d --build

echo ""
echo "==> Done. Containers:"
sudo docker compose -f docker-compose.prod.yml ps
PUBLIC_IP="$(curl -fsSL http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<EC2_PUBLIC_IP>')"
echo ""
echo "Open the game at:  http://$PUBLIC_IP:3000"
echo "(Make sure the security group allows inbound TCP 3000 and 4000.)"
