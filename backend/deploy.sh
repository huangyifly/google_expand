#!/usr/bin/env bash
# =============================================================================
# deploy.sh — 重启 Temu Scraper 后端服务
# 用法：cd backend && bash deploy.sh
# =============================================================================
set -euo pipefail

# ── 环境参数 ───────────────────────────────────────────────────────────────────
# 用法：
#   bash deploy.sh             → 本地开发（加载 .env，APP_ENV=development）
#   bash deploy.sh production  → 生产服务器（加载 .env.production，APP_ENV=production）
#   bash deploy.sh stop        → 停止服务
ENV="${1:-development}"

# ── 路径配置 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
PID_FILE="$SCRIPT_DIR/uvicorn.pid"
LOG_FILE="$SCRIPT_DIR/uvicorn.log"
APP_MODULE="app.main:app"
HOST="0.0.0.0"
PORT="8000"

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

stop_service() {
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            info "停止旧进程（PID=${OLD_PID}）"
            kill "$OLD_PID"
            # 最多等 5 秒
            for i in $(seq 1 10); do
                kill -0 "$OLD_PID" 2>/dev/null || break
                sleep 0.5
            done
            if kill -0 "$OLD_PID" 2>/dev/null; then
                warn "进程未响应，强制终止"
                kill -9 "$OLD_PID" 2>/dev/null || true
            fi
            info "旧进程已停止"
        else
            warn "PID 文件存在但进程已不在（PID=${OLD_PID}），跳过"
        fi
        rm -f "$PID_FILE"
    fi

    # 兜底：PID 文件过期或缺失时，仍按端口释放残留进程。
    LEFTOVER=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [ -n "$LEFTOVER" ]; then
        warn "检测到端口 ${PORT} 被占用（PID=${LEFTOVER}），正在释放"
        for PID in $LEFTOVER; do
            kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
        done
        sleep 1
    fi
}

if [ "$ENV" = "stop" ]; then
    stop_service
    info "服务已停止"
    exit 0
fi

# ── 根据环境选择 .env 文件 ────────────────────────────────────────────────────
if [ "$ENV" = "production" ]; then
    ENV_FILE="$SCRIPT_DIR/.env.production"
    info "环境：production（加载 .env.production）"
else
    ENV_FILE="$SCRIPT_DIR/.env"
    info "环境：development（加载 .env）"
fi

if [ ! -f "$ENV_FILE" ]; then
    error "找不到配置文件：$ENV_FILE"
    exit 1
fi

# =============================================================================
# 1. 检查 / 创建虚拟环境
# =============================================================================
if [ ! -f "$VENV_DIR/bin/activate" ]; then
    warn "虚拟环境不存在，正在创建：$VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi

info "激活虚拟环境：$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# =============================================================================
# 2. 停止旧进程
# =============================================================================
stop_service

# =============================================================================
# 3. 安装 / 更新依赖
# =============================================================================
info "安装依赖（requirements.txt）"
pip install -q --upgrade pip
pip install -q -r "$SCRIPT_DIR/requirements.txt"
info "依赖安装完成"

# =============================================================================
# 4. 启动 uvicorn（后台运行，日志追加到 uvicorn.log）
# =============================================================================
info "启动服务：${APP_MODULE} → ${HOST}:${PORT}"
cd "$SCRIPT_DIR"

nohup env APP_ENV="$ENV" uvicorn "$APP_MODULE" \
    --host "$HOST" \
    --port "$PORT" \
    --workers 1 \
    --log-level info \
    >> "$LOG_FILE" 2>&1 &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

# 等待 2 秒确认进程存活
sleep 2
if kill -0 "$NEW_PID" 2>/dev/null; then
    info "服务已启动 ✓  PID=${NEW_PID}  端口=${PORT}"
    info "日志文件：$LOG_FILE"
    info "停止服务：bash $SCRIPT_DIR/deploy.sh stop"
else
    error "服务启动失败，请检查日志：$LOG_FILE"
    tail -20 "$LOG_FILE"
    exit 1
fi
