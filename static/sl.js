class TRexSL {
    constructor(runner) {
        this.runner = runner;
        
        // 方案D：增加1维“是否踩在地面(is_grounded)”的布尔锚点，让AI明确前置物理状态
        this.stateSize = 16; 
        this.actionSize = 4; // 0: 原地, 1: 长跳, 2: 下蹲, 3: 短跳
        
        this.mode = 'idle'; // 'idle', 'collecting', 'playing'
        
        this.memory = []; // 存放特征和标签 [state, action]
        
        this.currentAction = 0; // 当前人类输入的动作

        this.frameCount = 0;
        this.frameSkip = 1;
        
        this.highestAiScore = 0;

        this.setupKeyboardInterception();
        this.setupKeyboard();
        this.setupHacks();
        this.setupUI();
        
        // 异步初始化模型，不阻塞UI渲染
        this.initModel().catch(e => console.error("模型初始化失败:", e));
        
        // 每秒上报一次最高分（如果AI正在玩并且打破了本地所知最高记录）
        setInterval(() => {
            if (this.mode === 'playing' && this.runner && this.runner.playing && !this.runner.crashed) {
                let currentScore = this.runner.distanceMeter.getActualDistance(Math.ceil(this.runner.distanceRan));
                if (currentScore > this.highestAiScore) {
                    this.highestAiScore = currentScore;
                    this.reportScoreToServer(currentScore);
                }
            }
        }, 1000);
    }
    
    reportScoreToServer(score) {
        fetch('/api/sl/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ score: score })
        }).catch(e => console.error("发送最高分失败:", e));
    }

    setupKeyboardInterception() {
        const originalOnKeyDown = window.Runner.prototype.onKeyDown;
        window.Runner.prototype.onKeyDown = function(e) {
            // 如果游戏已经结束，允许按空格或上箭头重新开始，不受“不可手玩”的限制
            if (this.crashed && (e.keyCode === 32 || e.keyCode === 38)) {
                originalOnKeyDown.call(this, e);
                return;
            }
            if (window.isManualPlayEnabled === false && (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40)) {
                e.preventDefault();
                showToast('⚠️ 当前不可手玩，请观察系统表现！');
                return;
            }
            originalOnKeyDown.call(this, e);
        };

        const originalOnKeyUp = window.Runner.prototype.onKeyUp;
        window.Runner.prototype.onKeyUp = function(e) {
            if (this.crashed && (e.keyCode === 32 || e.keyCode === 38)) {
                if (originalOnKeyUp) originalOnKeyUp.call(this, e);
                return;
            }
            if (window.isManualPlayEnabled === false && (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40)) {
                e.preventDefault();
                return;
            }
            if (originalOnKeyUp) originalOnKeyUp.call(this, e);
        };
    }

    async initModel() {
        console.log("初始化监督学习网络(TensorFlow.js)...");
        await tf.setBackend('cpu');
        
        this.model = tf.sequential();
        // 因为数据主要是人类经验，网络可以轻量一点
        this.model.add(tf.layers.dense({ units: 64, inputShape: [this.stateSize], activation: 'relu' }));
        // 移除 Dropout，因为对于 2000 帧这种极小数据集和小感知域，20% 的失活反而可能导致模型欠拟合，连必须跳的仙人掌都记不住。
        this.model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
        // 分类任务，最后一层 softmax 给概率
        this.model.add(tf.layers.dense({ units: this.actionSize, activation: 'softmax' }));
        
        // 监督学习通常用 categoricalCrossentropy
        this.model.compile({ optimizer: tf.train.adam(0.001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] }); 
        
        this.isModelTrained = false;
    }

    setupKeyboard() {
        this.jumpStartTime = 0;
        
        // 监听人类动作
        document.addEventListener('keydown', (e) => {
            if (window.isManualPlayEnabled === false) return;
            if (this.runner.crashed) return;
            if (e.keyCode === 38 || e.keyCode === 32) { // 上/空格
                if (this.currentAction !== 1) {
                    this.currentAction = 1;
                    this.jumpStartTime = performance.now();
                }
            } else if (e.keyCode === 40) { // 下
                this.currentAction = 2;
            }
        });
        document.addEventListener('keyup', (e) => {
            if (window.isManualPlayEnabled === false) return;
            if (e.keyCode === 38 || e.keyCode === 32) {
                if (this.currentAction === 1) {
                    this.currentAction = 0;
                    let holdDuration = performance.now() - this.jumpStartTime;
                    
                    // 如果人类按下的时间小于 150ms，我们认为这是一个“短跳”
                    if (holdDuration < 150) {
                        // 追溯我们收集到的 memory，把最近的 1 (长跳) 全改为 3 (短跳)
                        // 直到遇到 0 或跳跃状态不一致为止
                        for (let i = this.memory.length - 1; i >= 0; i--) {
                            if (this.memory[i].action === 1) {
                                this.memory[i].action = 3;
                            } else if (this.memory[i].action === 0) {
                                break;
                            }
                        }
                    }
                }
            } else if (e.keyCode === 40) {
                if (this.currentAction === 2) this.currentAction = 0;
            }
        });
    }

    getState() {
        let jumping = this.runner.tRex.jumping ? 1.0 : 0.0;
        let ducking = this.runner.tRex.ducking ? 1.0 : 0.0;
        let speed = this.runner.currentSpeed;
        
        // 扩展视野：最近的 3 个敌人特征
        let e1d = 800, e1w = 0, e1y = 80;
        let e2d = 800, e2w = 0, e2y = 80;
        let e3d = 800, e3w = 0, e3y = 80;
        // 扩展视野：最近的 2 个金币特征
        let c1d = 800, c1y = 80;
        let c2d = 800, c2y = 80;
        
        if (this.runner.horizon && this.runner.horizon.obstacles.length > 0) {
            let activeObs = this.runner.horizon.obstacles.filter(o => o.xPos + o.width > this.runner.tRex.xPos - 5);
            
            // 物理隔离敌人和金币
            let enemies = activeObs.filter(o => o.typeConfig.type !== 'COIN');
            let coins = activeObs.filter(o => o.typeConfig.type === 'COIN');

            if (enemies.length > 0) { e1d = enemies[0].xPos - this.runner.tRex.xPos; e1w = enemies[0].width; e1y = enemies[0].yPos; }
            if (enemies.length > 1) { e2d = enemies[1].xPos - this.runner.tRex.xPos; e2w = enemies[1].width; e2y = enemies[1].yPos; }
            if (enemies.length > 2) { e3d = enemies[2].xPos - this.runner.tRex.xPos; e3w = enemies[2].width; e3y = enemies[2].yPos; }
            
            if (coins.length > 0) { c1d = coins[0].xPos - this.runner.tRex.xPos; c1y = coins[0].yPos; }
            if (coins.length > 1) { c2d = coins[1].xPos - this.runner.tRex.xPos; c2y = coins[1].yPos; }
        }

        let timeToCollision = Math.max(0, e1d) / (speed || 1);

        return [
            Math.min(1.0, Math.max(0.0, speed / 30.0)), // 大幅放宽截断阈值，避免后期失明
            Math.min(1.0, Math.max(0.0, e1d / 800.0)), 
            Math.min(1.0, Math.max(0.0, e1w / 100.0)), 
            Math.min(1.0, Math.max(0.0, e1y / 150.0)), 
            Math.min(1.0, Math.max(0.0, e2d / 800.0)),
            Math.min(1.0, Math.max(0.0, e2w / 100.0)),
            Math.min(1.0, Math.max(0.0, e2y / 150.0)),
            Math.min(1.0, Math.max(0.0, e3d / 800.0)),
            Math.min(1.0, Math.max(0.0, e3w / 100.0)),
            Math.min(1.0, Math.max(0.0, e3y / 150.0)),
            Math.min(1.0, Math.max(0.0, c1d / 800.0)),
            Math.min(1.0, Math.max(0.0, c1y / 150.0)),
            Math.min(1.0, Math.max(0.0, c2d / 800.0)),
            Math.min(1.0, Math.max(0.0, c2y / 150.0)),
            Math.min(1.0, Math.max(0.0, timeToCollision / 100.0)),
            // 方案D（本体感知的回切）：提供一个干净的 1（在地上）或 0（在空中）
            this.runner.tRex.jumping ? 0.0 : 1.0
        ];
    }

    takeAction(action) {
        if (!this.runner || !this.runner.tRex) return;
        
        let isJumping = this.runner.tRex.jumping;
        let isDucking = this.runner.tRex.ducking;
        
        if (action === 1 || action === 3) { 
            if (isDucking) this.runner.tRex.setDuck(false);
            if (!isJumping && !this.runner.tRex.ducking) {
                this.runner.tRex.startJump(this.runner.currentSpeed);
                // 如果是短跳，我们让它在极短时间后主动下落
                if (action === 3) {
                    setTimeout(() => {
                        if (this.runner && this.runner.tRex && this.runner.tRex.jumping) {
                            this.runner.tRex.endJump();
                        }
                    }, 150); // 150毫秒后强制截断跳跃动量
                }
            }
        } else if (action === 2) { 
            if (isJumping) {
                this.runner.tRex.setSpeedDrop();
            } else if (!isDucking) {
                this.runner.tRex.setDuck(true);
            }
        } else { 
            if (isDucking) {
                this.runner.tRex.setDuck(false);
            }
            if (isJumping) {
                this.runner.tRex.endJump();
            }
        }
    }

    setupHacks() {
        let sl = this;
        let originalUpdate = window.Runner.prototype.update;

        // 接管实体更新逻辑
        window.Runner.prototype.update = function () {
            let wasPlaying = this.playing;
            originalUpdate.call(this);

            if (this.activated && !this.playingIntro && wasPlaying) {
                let done = this.crashed;
                
                // 当AI控制中且刚好撞死时（wasPlaying为true表示这是撞死的瞬间帧），延迟1秒自动重开
                if (done && sl.mode === 'playing') {
                    let finalScore = sl.runner.distanceMeter.getActualDistance(Math.ceil(sl.runner.distanceRan));
                    if (finalScore > sl.highestAiScore) {
                        sl.highestAiScore = finalScore;
                        sl.reportScoreToServer(finalScore);
                    }
                    setTimeout(() => {
                        if (sl.runner && sl.runner.crashed && sl.mode === 'playing') {
                            sl.runner.restart();
                        }
                    }, 1000);
                }

                sl.frameCount++;
                
                let shouldCheck = (sl.frameCount % sl.frameSkip === 0) || done;

                if (shouldCheck && !done) {
                    // 修复下蹲死亡时游戏引擎会自动累加xPos导致恐龙向右漂移，使得状态计算出错（失去控制）的问题
                    if (sl.runner.tRex) sl.runner.tRex.xPos = 50;
                    
                    let currentState = sl.getState();
                    
                    if (sl.mode !== 'playing') {
                        if (sl.mode !== 'collecting') {
                            sl.mode = 'collecting';
                            const statusEl = document.getElementById('sl-status');
                            if (statusEl) {
                                statusEl.innerText = '📸 人类手玩，采集标注数据中...';
                                statusEl.style.color = '#2c3e50';
                            }
                        }
                        // 人工收集模式：记录状态和当前动作
                        // 彻底弃用方案A断流逻辑，因为方案D（16维视觉带在地图特征）已经彻底解决了因果倒置。
                        // 撤销方案C（标签膨胀）：因为它人为地在你的数据里往回追溯了3帧的“空气跳跃”，这就相当于给你的纯净数据“投毒”，导致AI学到了必定过早起跳！
                        /*
                        if (sl.currentAction === 1 && sl.memory.length > 0) {
                            for(let i = sl.memory.length - 1; i >= Math.max(0, sl.memory.length - 3); i--){ 
                                if(sl.memory[i].action === 0) sl.memory[i].action = 1; 
                            }
                        }
                        */
                        
                        // 彻底解决因果倒置：只在地面上收集决定起跳的那一刻，或者不跳的那些时刻。
                        // 如果恐龙已经在空中（跳跃中），人类就算按着键，也是为了“维持滞空”，而不是重新发起一次跳跃。
                        // 【最终完美级数据采集】解决不跳、早跳、不短跳的终极方案
                        // 由于游戏引擎响应按键是瞬间的，等进入这个 update 循环时，恐龙早已处于 jumping=true 状态。
                        // 如果我们在天上持续采集，会导致因果倒置；如果我们加入追溯前3帧的标签膨胀，又会导致起跳过早砸死在刺上。
                        // 【破解方法】：我们只记录处于地面时的干净帧。当发现身处空中，并且人类正按着跳跃键时，
                        // 仅仅把“跳跃”的意识，覆盖给【起飞前贴在地面上的最后一帧】！
                        // 这样就获得了100%零误差起跳点的完美标记，且绝对没有冗余数据！
                        if (!sl.runner.tRex.jumping) {
                            if (sl.memory.length < 5000) {
                                sl.memory.push({
                                    state: currentState,
                                    action: sl.currentAction
                                });
                            } else {
                                // 收集达到 5000 帧，强制关闭该学生的手下手玩功能
                                window.localManualOverride = true;
                                window.isManualPlayEnabled = false;
                                if (sl.runner.playing) {
                                    sl.runner.crashed = true;
                                    sl.runner.gameOver();
                                }
                                const statusEl = document.getElementById('sl-status');
                                if (statusEl) {
                                    statusEl.innerText = '✅ 数据采集已达上限，手玩已关闭，请训练模型！';
                                    statusEl.style.color = '#e74c3c';
                                }
                            }
                        } else {
                            if (sl.currentAction === 1 || sl.currentAction === 3) {
                                if (sl.memory.length > 0) {
                                    let last = sl.memory[sl.memory.length - 1];
                                    // 仅回扣一帧，将本来是0的状态改为跳跃意图！
                                    if (last.action === 0) {
                                        last.action = sl.currentAction;
                                    }
                                }
                            }
                        }
                    } else if (sl.mode === 'playing') {
                        // 监督学习推理模式：主动忽略空中的预测指令，让跳跃(短/长跳)完全交由起始动作接管。
                        if (!sl.runner.tRex.jumping) {
                            tf.tidy(() => {
                                const qs = sl.model.predict(tf.tensor2d([currentState]));
                                const probs = Array.from(qs.dataSync());
                                let action = qs.argMax(1).dataSync()[0];
                                
                                // 防止脑补提前跳跃：设置安全阈值
                                // 因为没有了 Dropout，模型的确定性会变高。0.75 到 0.8 是比较理想的不早跳也不晚跳的区间。
                                if (action !== 0 && probs[action] < 0.75) {
                                    action = 0;
                                }
                                
                                // 不要在这显示复杂的预测分布信息，保持界面清爽
                                // let statusEl = document.getElementById('sl-status');
                                // if (statusEl) {
                                //     let actName = ['不动', '长跳', '下蹲', '短跳'];
                                //     statusEl.innerText = `🤖 预测: ${actName[action]} | 概率分布 [${probs.map(p=>p.toFixed(2)).join(', ')}]`;
                                // }
                                
                                sl.takeAction(action);
                            });
                        }
                    }
                }
                
                if (done) {
                    if (sl.mode === 'collecting') {
                        // 剔除死前约1秒钟（由于frameSkip=4，一秒钟大约记录15帧）的无效或错误经验
                        const framesToDrop = 60;
                        if (sl.memory.length > framesToDrop) {
                            sl.memory.splice(-framesToDrop, framesToDrop);
                        } else {
                            sl.memory = [];
                        }
                        console.log(`[SL] 抛弃了死前 ${framesToDrop} 帧可能存在的错误数据，提升样本质量。`);
                        
                        sl.mode = 'idle';
                        const statusEl = document.getElementById('sl-status');
                        if (statusEl) {
                            statusEl.innerText = '暂停 - 按空格键继续手玩采集数据';
                            statusEl.style.color = '#2c3e50';
                        }
                    }
                    sl.updateUI();
                }
            }
        };
    }

    async trainModel() {
        // 由于采样率提升到了 60帧/秒，原本的 1000 帧只需要 16 秒即可打满。
        // 为了确保能见到更多不同类型的仙人掌组合，修改门槛为 2000 帧（约 30 多秒的真实游玩时间）。
        if (this.memory.length < 2000) {
            showToast("没有收集到充足的数据！为了提升 AI 的能力，请至少收集 2000 帧的手玩数据。", 'warning');
            return;
        }

        // 核心修正：每次点击训练时，彻底销毁旧的神经网络并重新初始化随机权重。
        // 防止之前高配比训练出来的“优良基因（权重）”在重新训练低配比数据时依然残留，影响对照实验的严谨性。
        await this.initModel();
        
        this.mode = 'idle';
        document.getElementById('sl-status').innerText = '正在按设定比例处理数据，准备训练...';
        document.getElementById('sl-status').style.color = '#2c3e50';

        let idles = this.memory.filter(m => m.action === 0);
        let jumps = this.memory.filter(m => m.action === 1);
        let ducks = this.memory.filter(m => m.action === 2);
        let shortJumps = this.memory.filter(m => m.action === 3);
        
        let wIdle = 0.5;
        let idlesTarget = idles.length * wIdle;
        
        let wJump = jumps.length > 0 ? (idlesTarget / jumps.length) : 1.0;
        let wDuck = ducks.length > 0 ? (idlesTarget / ducks.length) : 1.0;
        let wShortJump = shortJumps.length > 0 ? (idlesTarget / shortJumps.length) : 1.0;
        
        wJump = Math.min(Math.max(wJump, 1.0), 100.0);
        wDuck = Math.min(Math.max(wDuck, 1.0), 30.0);
        wShortJump = Math.min(Math.max(wShortJump, 1.0), 100.0);

        // 根据倍率调整数据量
        const adjustData = (arr, weight) => {
            if (weight <= 0) return [];
            let result = [];
            let fullCopies = Math.floor(weight);
            for (let i = 0; i < fullCopies; i++) {
                result = result.concat(arr);
            }
            let fraction = weight - fullCopies;
            if (fraction > 0) {
                let shuffled = arr.slice().sort(() => Math.random() - 0.5);
                result = result.concat(shuffled.slice(0, Math.floor(arr.length * fraction)));
            }
            return result;
        };

        let balancedIdles = adjustData(idles, wIdle);
        let balancedJumps = adjustData(jumps, wJump);
        let balancedDucks = adjustData(ducks, wDuck);
        let balancedShortJumps = adjustData(shortJumps, wShortJump);
        
        let balancedMemory = [].concat(balancedIdles, balancedJumps, balancedDucks, balancedShortJumps);
        balancedMemory.sort(() => Math.random() - 0.5);
        
        console.log(`[数据调整] 总原帧: ${this.memory.length} -> 平衡后: ${balancedMemory.length} (停:${balancedIdles.length}, 长跳:${balancedJumps.length}, 蹲:${balancedDucks.length}, 短跳:${balancedShortJumps.length})`);

        if (balancedMemory.length === 0) {
            showToast("⚠️ 调整后的数据量为0！请检查数据配比倍数。", 'error');
            document.getElementById('sl-status').innerText = '请修改数据倍数配置';
            document.getElementById('sl-status').style.color = '#2c3e50';
            return;
        }

        // 准备数据
        let x = [];
        let y = [];
        
        for (let i = 0; i < balancedMemory.length; i++) {
            x.push(balancedMemory[i].state);
            let oneHot = [0, 0, 0, 0];
            oneHot[balancedMemory[i].action] = 1;
            y.push(oneHot);
        }

        const xT = tf.tensor2d(x);
        const yT = tf.tensor2d(y);

        // 为了在页面展示训练进度，我们在 Epoch 循环中交出控制权
        const totalEpochs = 50;
        await this.model.fit(xT, yT, { 
            epochs: totalEpochs, // 加深训练轮数，让模型更好地学习“极限距离抢救”和“混合特征”
            batchSize: 64,
            shuffle: true,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    let percent = Math.round(((epoch + 1) / totalEpochs) * 100);
                    document.getElementById('sl-status').innerText = `正在分析你的操作录像并训练 AI，当前进度: ${percent}%`;
                }
            }
        });

        xT.dispose();
        yT.dispose();

        // 强行渲染 100%，否则弹窗阻塞时 DOM 还没来得及更新
        document.getElementById('sl-status').innerText = `正在分析你的操作录像并训练 AI，当前进度: 100%`;

        // 延迟 100ms 弹出提示，确保浏览器已经重绘（Repaint）完毕
        setTimeout(() => {
            showToast("🎯 训练完毕！AI学会了你的操作模式！", 'success');
            this.isModelTrained = true;
            
            // 训练完毕后，不强制开启AI控制，仅作文字提示
            document.getElementById('sl-status').innerText = '模型训练完毕！请开启右侧“AI控制”开关查看效果。';
            document.getElementById('sl-status').style.color = '#27ae60';
            
            const aiToggle = document.getElementById('ai-toggle');
            if (aiToggle && aiToggle.checked) {
                // 如果用户原本就保持着开启状态，则继续触发AI逻辑
                const event = new Event('change');
                aiToggle.dispatchEvent(event);
            }
            
            this.updateUI();
        }, 100);
    }

    setupUI() {
        let oldPanel = document.getElementById('sl-panel');
        if(oldPanel) oldPanel.remove();

        const style = document.createElement('style');
        style.innerHTML = `
            #sl-panel { position: absolute; top: 340px; left: 50%; transform: translateX(-50%); background: #fdfbfb; padding: 15px 25px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); font-family: monospace; font-size: 14px; text-align: center; z-index: 10000; color: #333; width: 550px; border: 2px solid #2c3e50;}
            .stat-row { margin: 5px 0; }
            .val { font-weight: bold; color: #d35400; }
            #sl-status { color: #2c3e50; font-weight: bold; font-size: 15px; }
            button { padding: 8px 16px; margin: 10px 5px 0; cursor: pointer; font-family: inherit; border: 1px solid #999; background: #eee; border-radius: 4px; font-weight: bold; }
            button:hover { background: #ddd; }
            #btn-collect { background-color: #ffcccc; border-color: #ff9999; }
            #btn-play { background-color: #c8d6e5; border-color: #8395a7; }
            .switch { position: relative; display: inline-block; width: 44px; height: 24px; vertical-align: middle; margin-left: 10px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
            .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .slider { background-color: #2ecc71; }
            input:checked + .slider:before { transform: translateX(20px); }
            
            .icon-btn { position: relative; background: rgba(255,255,255,0.9); color: #34495e; border: 2px solid #bdc3c7; border-radius: 50%; width: 44px; height: 44px; display: flex; justify-content: center; align-items: center; cursor: pointer; font-size: 20px; box-shadow: 0 3px 8px rgba(0,0,0,0.25); transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); padding: 0; }
            .icon-btn:hover { background: #fff; transform: scale(1.15); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
            .icon-btn:active { transform: scale(0.95); }
            
            /* CSS瞬时提示文字 */
            .icon-btn[data-tooltip]::after { content: attr(data-tooltip); position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%); background: rgba(44, 62, 80, 0.9); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.2s; z-index: 1000; font-family: sans-serif; font-weight: normal; }
            .icon-btn[data-tooltip]:hover::after { opacity: 1; }
            
            .stat-badge { display: inline-block; padding: 2px 6px; margin: 0 3px; border-radius: 4px; background: #eee; font-size: 13px; border: 1px solid #ccc; }
            .weight-input { width: 40px; text-align: center; margin-left: 5px; border: 1px solid #ccc; border-radius: 4px; padding: 2px; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'sl-panel';
        
        panel.innerHTML = `
            <div class="stat-row">
                <span id="sl-status">请按空格开始游戏</span>
            </div>
            
            <div class="stats-panel" style="display: flex; flex-direction: column; align-items: center; gap: 8px; font-family: monospace; font-size: 12px; margin-top: 15px; color: #ecf0f1; width: max-content; margin-left: auto; margin-right: auto;">
                <div class="stat-item" style="background: rgba(44, 62, 80, 0.85); padding: 4px 12px; border-radius: 6px; border: 1px solid #34495e; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">采集量 <span id="sl-mem" class="stat-highlight" style="color: #f1c40f; font-weight: bold; font-size: 14px;">0</span> 帧</div>

            </div>

            <!-- 按钮区域居中布局 -->
            <div style="display: flex; flex-direction: row; justify-content: center; align-items: center; border-top: 1px solid #ddd; padding-top: 15px; margin-top: 15px; gap: 30px; width: 100%;">
                
                <!-- 训练模型按钮 -->
                <div style="display: flex; gap: 15px; justify-content: center; align-items: center;">
                    <div class="icon-btn" id="btn-train" data-tooltip="开始训练模型" style="color: #27ae60; border-color: #27ae60; width: 40px; height: 40px;">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>
                            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path>
                            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path>
                            <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path>
                            <path d="M6.002 5.125A3 3 0 0 0 6.401 6.5"></path>
                            <path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path>
                            <path d="M19.938 10.5a4 4 0 0 1 .585.396"></path>
                            <path d="M6 18a4 4 0 0 1-1.967-.516"></path>
                            <path d="M19.967 17.484A4 4 0 0 1 18 18"></path>
                        </svg>
                    </div>
                </div>
                
                <!-- AI控制按钮 -->
                <div style="display: flex; justify-content: center; align-items: center;">
                    <div style="font-weight: bold; color: #555; display: flex; align-items: center; font-size: 13px;">
                        AI控制
                        <label class="switch" title="开启/关闭机器代打" style="margin: 0 0 0 10px;">
                            <input type="checkbox" id="ai-toggle">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);



        document.getElementById('btn-train').addEventListener('click', () => {
            this.trainModel();
        });

        document.getElementById('ai-toggle').addEventListener('change', (e) => {
            e.target.blur(); // 失去焦点，防止按空格误触发
            const isChecked = e.target.checked;
            if (isChecked) {
                if (!this.model || !this.isModelTrained) {
                    showToast("模型还未训练，请先收集充分的数据并点击训练模型！", 'warning');
                    e.target.checked = false;
                    return;
                }
                this.mode = 'playing';
                document.getElementById('sl-status').innerText = '🤖 AI 控制中';
                document.getElementById('sl-status').style.color = '#2c3e50';
                if (!this.runner.playing) {
                    this.runner.restart();
                }
            } else {
                this.mode = 'idle';
                document.getElementById('sl-status').innerText = '暂停 - 按空格键继续手玩采集数据';
                document.getElementById('sl-status').style.color = '#2c3e50';
            }
        });
        
        setInterval(() => this.updateUI(), 500);
    }

    updateUI() {
        const memEl = document.getElementById('sl-mem');
        if (memEl) memEl.innerText = `${this.memory.length}`;
        
        let idleCount = 0, jumpCount = 0, duckCount = 0;
        for (let i = 0; i < this.memory.length; i++) {
            if (this.memory[i].action === 0) idleCount++;
            else if (this.memory[i].action === 1) jumpCount++;
            else if (this.memory[i].action === 2) duckCount++;
        }
        
        const idleEl = document.getElementById('sl-mem-idle');
        const jumpEl = document.getElementById('sl-mem-jump');
        const duckEl = document.getElementById('sl-mem-duck');
        if (idleEl) idleEl.innerText = idleCount;
        if (jumpEl) jumpEl.innerText = jumpCount;
        if (duckEl) duckEl.innerText = duckCount;
    }
}

// 脚本加载完之后，注入接管
let slInst = null;
const originalRunnerInit = window.Runner.prototype.init;
window.Runner.prototype.init = function () {
    originalRunnerInit.call(this);
    if (!slInst) {
        if (!window.tfLoaded) {
            let script = document.createElement('script');
            script.src = '/static/lib/tf.min.js';
            script.onload = () => {
                window.tfLoaded = true;
                slInst = new TRexSL(this);
                window.sl = slInst; // 把 SL 大脑挂到全局方便排查
            };
            document.head.appendChild(script);
        } else {
            slInst = new TRexSL(this);
            window.sl = slInst;
        }
    }
};
