#!/bin/bash

# 确保在项目根目录下执行
cd "$(dirname "$0")"

echo "正在后台启动 app.py..."

# 使用虚拟环境中的 Python 运行，使用 nohup 保持后台运行
# 标准输出和错误都会被重定向到 app.log 文件中
nohup venv/bin/python app.py > app.log 2>&1 &

echo "启动成功！进程 PID: $!"
echo "你可以使用 'tail -f app.log' 命令来查看运行日志。"
