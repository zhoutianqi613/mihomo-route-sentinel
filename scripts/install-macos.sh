#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=${1:-$(dirname -- "$SCRIPT_DIR")}
CONFIG_PATH=${2:-$PROJECT_DIR/config.json}
NODE_PATH=$(command -v node || true)
RUNTIME_DIR=$PROJECT_DIR/var
LABEL=io.github.mihomo-route-sentinel
PLIST_DIR=$HOME/Library/LaunchAgents
PLIST_PATH=$PLIST_DIR/$LABEL.plist

if [ "$(uname -s)" != Darwin ]; then
  echo "错误：此脚本仅支持 macOS。" >&2
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
case "$PROJECT_DIR$CONFIG_PATH$NODE_PATH" in
  *'|'*|*'&'*|*'@'*|*'<'*|*'>'*|*'\'*) echo "错误：路径包含安装器不支持的特殊字符。" >&2; exit 1 ;;
esac

mkdir -p "$PLIST_DIR" "$RUNTIME_DIR"
sed \
  -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
  -e "s|@CONFIG_PATH@|$CONFIG_PATH|g" \
  -e "s|@NODE_PATH@|$NODE_PATH|g" \
  -e "s|@RUNTIME_DIR@|$RUNTIME_DIR|g" \
  "$SCRIPT_DIR/mihomo-route-sentinel.plist" > "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
echo "已安装并启动 $LABEL。"
