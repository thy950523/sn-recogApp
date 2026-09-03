#!/bin/bash
# ============================================================
# SN扫码登记工具 - 一键停止脚本
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SN]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; }

kill_pid_file() {
  local pid_file="$1"
  local name="$2"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && log "已停止 $name (PID=$pid)" || warn "停止 $name 失败"
    else
      warn "$name PID文件过期或进程已终止"
    fi
    rm -f "$pid_file"
  fi
}

kill_by_port() {
  local port="$1"
  local name="$2"
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null && log "已停止 $name (:$port)" || warn "停止 $name 失败"
  else
    warn "$name (:$port) 未运行"
  fi
}

echo ""
log "=========================================="
log "  SN扫码登记工具 - 停止所有服务"
log "=========================================="
echo ""

# 先尝试按 PID 文件停止
kill_pid_file "$PID_DIR/frontend.pid" "前端"
kill_pid_file "$PID_DIR/python.pid" "Python OCR"

# 再按端口兜底（清理遗漏进程）
kill_by_port 3000 "前端"
kill_by_port 3458 "Python OCR"

echo ""
log "全部服务已停止"
echo ""
