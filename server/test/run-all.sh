#!/bin/bash
# 端到端验收：需要空库/可重复运行（脚本内照片内容带 nonce，互不冲突）。
# 用法：先启动服务（npm start），再执行 bash test/run-all.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/acceptance-basics.sh"
bash "$DIR/acceptance-scenarios.sh"
echo "全部验收通过"
