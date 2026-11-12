#!/usr/bin/env bash
set -euo pipefail

UPDATE_ROOT="/var/www/gaogeaii/updates"
UPDATE_WIN_DIR="${UPDATE_ROOT}/win"
UPDATE_MAC_DIR="${UPDATE_ROOT}/mac"
UPDATE_LINUX_DIR="${UPDATE_ROOT}/linux"
UPDATE_THEME_DIR="${UPDATE_ROOT}/themes"
TUTORIAL_VIDEO_ROOT="/var/www/gaogeaii/tutorial-videos"
NGINX_SITE="/etc/nginx/sites-available/gaogeaii-updates"
NGINX_ENABLED="/etc/nginx/sites-enabled/gaogeaii-updates"
GAOGE_UPDATE_SERVER_NAME="${GAOGE_UPDATE_SERVER_NAME:-updates.example.invalid}"

if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y nginx
fi

sudo install -d -m 0755 "${UPDATE_WIN_DIR}" "${UPDATE_MAC_DIR}" "${UPDATE_LINUX_DIR}" "${UPDATE_THEME_DIR}" "${TUTORIAL_VIDEO_ROOT}"

sudo tee "${NGINX_SITE}" >/dev/null <<NGINX
server {
  listen 80;
  server_name ${GAOGE_UPDATE_SERVER_NAME};

  location /gaogeaii/updates/ {
    alias /var/www/gaogeaii/updates/;
    autoindex off;
    add_header Cache-Control "no-store";
    try_files $uri =404;
  }

  location /gaogeaii/tutorial-videos/ {
    alias /var/www/gaogeaii/tutorial-videos/;
    autoindex off;
    add_header Cache-Control "public, max-age=604800";
    try_files $uri =404;
  }
}
NGINX

sudo ln -sf "${NGINX_SITE}" "${NGINX_ENABLED}"
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "Update server ready:"
echo "  https://${GAOGE_UPDATE_SERVER_NAME}/gaogeaii/updates/win/latest.json"
echo "  https://${GAOGE_UPDATE_SERVER_NAME}/gaogeaii/updates/mac/latest.json"
echo "  https://${GAOGE_UPDATE_SERVER_NAME}/gaogeaii/updates/linux/latest.json"
echo "  https://${GAOGE_UPDATE_SERVER_NAME}/gaogeaii/updates/themes/catalog.json"
echo "Tutorial videos directory ready:"
echo "  https://${GAOGE_UPDATE_SERVER_NAME}/gaogeaii/tutorial-videos/"
