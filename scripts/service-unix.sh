#!/usr/bin/env sh
set -eu

ACTION=${1:-status}
NAME=mihomo-route-sentinel
LABEL=io.github.mihomo-route-sentinel

case "$ACTION" in
  start|stop|restart|enable|disable|status) ;;
  *) echo "用法：$0 {start|stop|restart|enable|disable|status}" >&2; exit 2 ;;
esac

case "$(uname -s)" in
  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "错误：当前 Linux 未提供 systemd/systemctl。" >&2
      exit 1
    fi
    case "$ACTION" in
      start) systemctl start "$NAME.service" ;;
      stop) systemctl stop "$NAME.service" ;;
      restart) systemctl restart "$NAME.service" ;;
      enable) systemctl enable "$NAME.service" ;;
      disable) systemctl disable --now "$NAME.service" ;;
      status) systemctl status --no-pager "$NAME.service" ;;
    esac
    ;;
  Darwin)
    DOMAIN="gui/$(id -u)"
    TARGET="$DOMAIN/$LABEL"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    case "$ACTION" in
      start)
        if ! launchctl print "$TARGET" >/dev/null 2>&1; then
          [ -f "$PLIST" ] || { echo "错误：未安装 $PLIST。" >&2; exit 1; }
          launchctl bootstrap "$DOMAIN" "$PLIST"
        else
          launchctl kickstart "$TARGET"
        fi
        ;;
      stop) launchctl bootout "$TARGET" 2>/dev/null || true ;;
      restart)
        [ -f "$PLIST" ] || { echo "错误：未安装 $PLIST。" >&2; exit 1; }
        launchctl bootout "$TARGET" 2>/dev/null || true
        launchctl bootstrap "$DOMAIN" "$PLIST"
        ;;
      enable) launchctl enable "$TARGET" ;;
      disable)
        launchctl bootout "$TARGET" 2>/dev/null || true
        launchctl disable "$TARGET"
        ;;
      status) launchctl print "$TARGET" ;;
    esac
    ;;
  *) echo "错误：仅支持使用 systemd 的 Linux 和 macOS launchd。" >&2; exit 1 ;;
esac
