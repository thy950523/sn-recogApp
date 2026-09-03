#!/bin/bash
# ============================================================
# SN扫码登记工具 - 一键启动脚本
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

mkdir -p "$PID_DIR"

FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
PY_PID_FILE="$PID_DIR/python.pid"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[SN]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; }

# 检查端口是否被占用
is_port_used() {
  lsof -i :"$1" > /dev/null 2>&1
}

# 检查某个 PID 是否存活
is_alive() {
  kill -0 "$1" 2>/dev/null
}

# ----------------------------------------------------------
# 启动前端（Vite HTTPS dev server）
# ----------------------------------------------------------
start_frontend() {
  if [ -f "$FRONTEND_PID_FILE" ] && is_alive "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
    warn "前端已在运行 (PID=$(cat $FRONTEND_PID_FILE))"
  elif is_port_used 3000; then
    warn "端口 3000 被占用，前端可能已在运行"
  else
    log "启动前端 (Vite HTTPS :3000)..."
    cd "$SCRIPT_DIR"
    for i in {1..10}; do
      is_port_used 3000 && break
      sleep 0.5
    done
    if is_port_used 3000; then
      warn "前端已在运行，跳过"
    else
      npm run dev > /dev/null 2>&1 &
      echo $! > "$FRONTEND_PID_FILE"
      sleep 3
      if is_port_used 3000; then
        log "前端启动成功 (PID=$(cat $FRONTEND_PID_FILE))"
      else
        warn "前端启动延迟，等待中..."
        sleep 5
      fi
    fi
  fi
}

# ----------------------------------------------------------
# 启动 Python OCR 引擎（RapidOCR）
# Vite proxy /ocr/ → :3458
# ----------------------------------------------------------
start_python_ocr() {
  if [ -f "$PY_PID_FILE" ] && is_alive "$(cat "$PY_PID_FILE")" 2>/dev/null; then
    warn "Python OCR 引擎已在运行 (PID=$(cat $PY_PID_FILE))"
  elif is_port_used 3458; then
    warn "端口 3458 被占用，Python OCR 可能已在运行"
  else
    log "启动 Python OCR 引擎 (:3458 RapidOCR)..."
    cd "$SCRIPT_DIR/ocr-server"
    python3 ocr_engine.py > /dev/null 2>&1 &
    echo $! > "$PY_PID_FILE"
    sleep 3
    if is_port_used 3458; then
      log "Python OCR 引擎启动成功 (PID=$(cat $PY_PID_FILE))"
    else
      warn "Python OCR 引擎启动延迟，等待中..."
      sleep 5
    fi
  fi
}

# ----------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------
main() {
  echo ""
  log "=========================================="
  log "  SN扫码登记工具 - 启动所有服务"
  log "=========================================="
  echo ""

  start_frontend
  start_python_ocr

  echo ""
  log "=========================================="
  log "  服务状态"
  log "=========================================="

  if is_port_used 3000; then
    log "前端:         :3000 ✅ (HTTPS)"
  else
    err "前端:          :3000 ❌ 未运行"
  fi

  if is_port_used 3458; then
    log "Python OCR:    :3458 ✅ (RapidOCR)"
  else
    warn "Python OCR:    :3458 ❌ 未运行（OCR 将回退本地）"
  fi

  echo ""
  log "访问地址: https://localhost:3000"
  log "（移动端访问: https://<本机IP>:3000）"
  echo ""
}

main
