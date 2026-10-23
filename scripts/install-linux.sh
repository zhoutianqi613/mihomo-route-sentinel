#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=${1:-$(dirname -- "$SCRIPT_DIR")}
CONFIG_PATH=${2:-$PROJECT_DIR/config.json}
SERVICE_USER=${3:-${SUDO_USER:-root}}
UNIT_NAME=mihomo-route-sentinel.service
UNIT_PATH=/etc/systemd/system/$UNIT_NAME
NODE_PATH=$(command -v node || true)
RUNTIME_DIR=$PROJECT_DIR/var

if [ "$(id -u)" -ne 0 ]; then
  echo "错误：Linux systemd 安装需要 root，请使用 sudo 重试。" >&2
  exit 1
fi
if [ -z "$NODE_PATH" ]; then
  echo "错误：未找到 Node.js 20+。" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/src/cli.mjs" ] || [ ! -f "$CONFIG_PATH" ]; then
  echo "错误：项目目录或配置文件不存在。" >&2
  exit 1
fi
case "$PROJECT_DIR$CONFIG_PATH$NODE_PATH$SERVICE_USER" in
  *'|'*|*'&'*|*'@'*|*'<'*|*'>'*|*'\'*) echo "错误：路径或用户名包含安装器不支持的特殊字符。" >&2; exit 1 ;;
esac

mkdir -p "$RUNTIME_DIR"
chown "$SERVICE_USER" "$RUNTIME_DIR"
sed \
  -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
  -e "s|@CONFIG_PATH@|$CONFIG_PATH|g" \
  -e "s|@NODE_PATH@|$NODE_PATH|g" \
  -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
  -e "s|@RUNTIME_DIR@|$RUNTIME_DIR|g" \
  "$SCRIPT_DIR/mihomo-route-sentinel.service" > "$UNIT_PATH"

systemctl daemon-reload
systemctl enable "$UNIT_NAME"
echo "已安装并启用 $UNIT_NAME；使用 sh service-unix.sh start 启动。"
