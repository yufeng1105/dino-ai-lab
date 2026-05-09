from flask import Flask, render_template, request, redirect, url_for, session, make_response, send_from_directory
import uuid
import os
import json

app = Flask(__name__)
app.secret_key = 'super_secret_key_for_trex_lab'

ANSWERS_DIR = 'answers'
os.makedirs(ANSWERS_DIR, exist_ok=True)

def load_answers(task):
    path = os.path.join(ANSWERS_DIR, f"{task}.json")
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {}
    return {}

def save_answers(task, data):
    path = os.path.join(ANSWERS_DIR, f"{task}.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# 全局状态
# 记录已登录的学生 {student_name: session_id}
active_students = {}
# 游戏任务的开启状态 default is False
class_state = {"started": False}
drawers_state = {"right_unlocked": False}
tasks_state = {
    'sym': False,
    'sl': False,
    'rl': False
}
manual_play_state = {
    'sym': False,
    'sl': False
}
# 记录每个任务的设计方案 {student_name: '设计方案文本'}
student_designs_sl = load_answers('sl')
student_designs_rl = load_answers('rl')
# 记录未来预测 {student_name: '预测文本'}
sym_designs = load_answers('sym')

# SL 的高分榜单 {student_name: highest_score}
sl_high_scores = load_answers('sl_high_scores')

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

def get_students():
    try:
        with open('students_name.txt', 'r', encoding='utf-8') as f:
            # 过滤空行并且去除头尾空格，包括可能的 % 符号
            lines = [line.strip().replace('%', '') for line in f.readlines() if line.strip()]
            return [line for line in lines if line]
    except Exception as e:
        print("Error reading students_name.txt", e)
        return []

@app.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('user_id'):
        return redirect(url_for('index'))

    if request.method == 'POST':
        role = request.form.get('role')
        
        if role == 'student':
            student_name = request.form.get('student_name')
            if not student_name:
                return render_template('login.html', students=get_students(), error="请选择姓名")
                
            # 检查单点登录
            if student_name in active_students:
                # 检查是否是当前会话
                if active_students[student_name] != session.get('session_id'):
                    return render_template('login.html', students=get_students(), error=f"学生 {student_name} 已在其他浏览器登录！")
                    
            session_id = str(uuid.uuid4())
            session['session_id'] = session_id
            session['role'] = 'student'
            session['user_id'] = student_name
            active_students[student_name] = session_id
            resp = make_response(redirect(url_for('index')))
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            return resp
            
        elif role == 'expert':
            session['role'] = 'expert'
            session['user_id'] = f"expert_{str(uuid.uuid4())[:8]}"
            resp = make_response(redirect(url_for('index')))
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            return resp

    resp = make_response(render_template('login.html', students=get_students()))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/teacher', methods=['GET', 'POST'])
def teacher_login():
    if session.get('user_id') == 'teacher_admin':
        return redirect(url_for('serve_lesson'))

    if request.method == 'POST':
        password = request.form.get('password')
        if password == 'lanrunit': # 教师登录密码
            session['role'] = 'teacher'
            session['user_id'] = 'teacher_admin'
            class_state['started'] = True
            tasks_state['sym'] = True
            resp = make_response(redirect(url_for('serve_lesson')))
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            return resp
        else:
            resp = make_response(render_template('teacher_login.html', error="教师密码错误"))
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            return resp
            
    resp = make_response(render_template('teacher_login.html'))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/logout')
def logout():
    role = session.get('role')
    user_id = session.get('user_id')
    if role == 'student' and user_id in active_students:
        if active_students[user_id] == session.get('session_id'):
            del active_students[user_id]
    session.clear()
    return redirect(url_for('login'))

@app.route('/lesson')
def serve_lesson():
    """提供 lesson.html 的访问入口"""
    if session.get('role') != 'teacher':
        return redirect(url_for('login'))
    return send_from_directory(app.root_path, 'lesson.html')

@app.route('/')
def index():
    if 'role' not in session:
        return redirect(url_for('login'))
        
    resp = make_response(render_template('index.html', 
                          role=session.get('role'),
                          user_id=session.get('user_id'),
                          tasks=tasks_state))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/task/<task_name>')
def task(task_name):
    if 'role' not in session:
        return redirect(url_for('login'))
        
    check_name = task_name
    if task_name in ['rl', 'rl_dashboard']:
        check_name = 'rl'
        
    if check_name not in tasks_state:
        return "Task not found", 404
        
    # 教师拥有无限权限，学生/专家需要任务开启
    if session.get('role') != 'teacher' and not tasks_state[check_name]:
        return redirect(url_for('index'))
        
    return render_template(f'{task_name}.html', user_id=session.get('user_id'), role=session.get('role'), tasks=tasks_state, manual_play=manual_play_state, drawers_state=drawers_state, active_nav=check_name)

@app.route('/api/start_class', methods=['POST'])
def start_class():
    if session.get('role') != 'teacher':
        return {"error": "Unauthorized"}, 403
    class_state['started'] = True
    tasks_state['sym'] = True
    return {"success": True}

@app.route('/api/class_state', methods=['GET'])
def get_class_state():
    return {"started": class_state.get('started', False)}

@app.route('/api/toggle_task', methods=['POST'])
def toggle_task():
    if session.get('role') != 'teacher':
        return {"error": "Unauthorized"}, 403
    
    data = request.json
    task_name = data.get('task')
    state = data.get('state')
    
    if task_name in tasks_state:
        tasks_state[task_name] = bool(state)
        return {"success": True, "state": tasks_state[task_name]}
    
    if task_name in drawers_state:
        drawers_state[task_name] = bool(state)
        return {"success": True, "state": drawers_state[task_name]}
        
    return {"error": "Invalid task"}, 400

@app.route('/api/sl/score', methods=['POST'])
def update_sl_score():
    if not session.get('user_id'):
        return {"error": "Unauthorized"}, 403
    
    student_name = session.get('user_id')
    data = request.json
    score = data.get('score', 0)
    
    current_high = sl_high_scores.get(student_name, 0)
    if score > current_high:
        sl_high_scores[student_name] = score
        save_answers('sl_high_scores', sl_high_scores)
        
    return {"success": True, "high_score": sl_high_scores[student_name]}

@app.route('/api/sl/leaderboard', methods=['GET'])
def get_sl_leaderboard():
    # 按照分数降序排序
    sorted_scores = sorted(sl_high_scores.items(), key=lambda x: x[1], reverse=True)
    leaderboard = [{"name": k, "score": v} for k, v in sorted_scores]
    return {"leaderboard": leaderboard, "total_students": len(leaderboard)}
    if task_name == 'right_unlocked':
        drawers_state['right_unlocked'] = bool(state)
        return {"success": True, "state": drawers_state['right_unlocked']}
    return {"error": "Task not found"}, 404

@app.route('/api/toggle_manual_play', methods=['POST'])
def toggle_manual_play():
    if session.get('role') != 'teacher':
        return {"error": "Unauthorized"}, 403
    
    data = request.json
    task_name = data.get('task')
    state = data.get('state')
    
    if task_name in manual_play_state:
        manual_play_state[task_name] = bool(state)
        return {"success": True, "state": manual_play_state[task_name]}
    return {"error": "Task not found"}, 404

@app.route('/api/drawer_state', methods=['GET'])
def get_drawer_state():
    return {"right_unlocked": drawers_state.get("right_unlocked", False)}

@app.route('/api/task_state/<task_name>', methods=['GET'])
def get_task_state(task_name):
    # Teacher always sees tasks as unlocked
    if session.get('role') == 'teacher':
        return {"unlocked": True}
    return {"unlocked": tasks_state.get(task_name, False)}

@app.route('/api/manual_play_state/<task_name>', methods=['GET'])
def get_manual_play_state(task_name):
    return {"manual_play": manual_play_state.get(task_name, False)}

@app.route('/api/submit_eval/<task_name>', methods=['POST'])
def submit_eval(task_name):
    if not session.get('user_id'):
        return {"error": "只有学生可以提交评价"}, 403
    data = request.json
    answer = data.get('answers')
    user_id = session.get('user_id')
    
    if task_name == 'sl':
        if user_id in student_designs_sl:
            student_designs_sl.pop(user_id)
        student_designs_sl[user_id] = answer
        save_answers('sl', student_designs_sl)
    elif task_name == 'rl':
        if user_id in student_designs_rl:
            student_designs_rl.pop(user_id)
        student_designs_rl[user_id] = answer
        save_answers('rl', student_designs_rl)
    else:
        return {"error": "未知的任务名称"}, 400
        
    return {"success": True}

@app.route('/api/submit_eval/sym', methods=['POST'])
def submit_sym_eval():
    if not session.get('user_id'):
        return {"error": "只有学生可以提交"}, 403
    data = request.json
    answer = data.get('answer') # Option A/B/C/D
    user_id = session.get('user_id')
    if user_id in sym_designs:
        sym_designs.pop(user_id)
    sym_designs[user_id] = answer
    save_answers('sym', sym_designs)
    return {"success": True}

@app.route('/api/eval_stats/sym', methods=['GET'])
def sym_eval_stats():
    if session.get('role') != 'teacher':
        return {"error": "Unauthorized"}, 403
        
    distribution = {'A': 0, 'B': 0, 'C': 0, 'D': 0}
    for ans in sym_designs.values():
        if ans in distribution:
            distribution[ans] += 1
            
    return {
        "total_students": len(sym_designs),
        "distribution": distribution,
        "designs": sym_designs
    }

@app.route('/api/get_design/sym', methods=['GET'])
def get_sym_design():
    if not session.get('user_id'):
        return {"error": "Unauthorized"}, 403
    return {"design": sym_designs.get(session.get('user_id'), "")}

@app.route('/api/eval_stats/<task_name>', methods=['GET'])
def eval_stats(task_name):
    if session.get('role') != 'teacher':
        return {"error": "Unauthorized"}, 403
        
    if task_name == 'sl':
        designs = student_designs_sl
    elif task_name == 'rl':
        designs = student_designs_rl
    else:
        designs = {}
        
    return {
        "total_students": len(designs),
        "designs": designs
    }

@app.route('/api/get_design/<task_name>', methods=['GET'])
def get_design(task_name):
    if not session.get('user_id'):
        return {"error": "Unauthorized"}, 403
    
    if task_name == 'sl':
        design = student_designs_sl.get(session.get('user_id'), "")
    elif task_name == 'rl':
        design = student_designs_rl.get(session.get('user_id'), "")
    else:
        design = ""
        
    return {"design": design}

if __name__ == '__main__':
    app.run(debug=True, port=8000, host='0.0.0.0')
