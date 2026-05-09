#!/bin/bash

echo "正在结束运行的 app.py 进程..."
pkill -f "python app.py"

if [ $? -eq 0 ]; then
    echo "app.py 进程已成功终止！"
else
    echo "未找到正在运行的 app.py 进程，可能已经结束。"
fi
