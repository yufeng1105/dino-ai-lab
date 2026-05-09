// 彻底抛弃虚假的数学沙盘，我们接管原生《小恐龙》物理引擎，并给它装上时间光速引擎！
class TRexAI {
    constructor(runner) {
        this.runner = runner;
        
        // 解析 URL 判断当前是不是演示模式或Actor节点
        const urlParams = new URLSearchParams(window.location.search);
        this.isDemo = urlParams.get('mode') === 'demo';
        this.isActor = urlParams.get('mode') === 'actor'; // 新增 Actor 模式

        // 为教育展示课：彻底清理打工恐龙的旁边面板UI信息
        if (this.isActor) {
            document.body.classList.add('is-actor-mode');
        }
        if (this.isDemo) {
            document.body.classList.add('is-demo-mode');
        }
        
        this.episodes = 0;
        this.highestScore = 0;
        this.recentScores = []; // 添加数组记录近期分数
        this.isTraining = false;
        
        // 统一模型输入！和监督学习保持相同的状态空间(16维)和动作空间(4维)
        this.stateSize = 16;  
        this.actionSize = 4; // 0: 原地, 1: 长跳, 2: 下蹲, 3: 短跳
        this.memory = [];
        this.badMemory = []; // 存放负反馈记忆(死亡惩罚)
        this.flyMemory = []; // 新增：专属飞行物(翼龙)记忆区，对付灾难性遗忘
        this.goodMemory = []; // 新增：存放吃金币等正反馈记忆
        this.episodeMemory = []; // [分布式] 仅存一局的数据，死后打包发给云端
        
        this.maxMemory = 100000; 
        this.maxBadMemory = 20000; 
        this.maxFlyMemory = 20000; // 翼龙库上限
        this.maxGoodMemory = 20000; // 金币正反馈库上限
        this.maxGoodMemory = 20000; // 金币正反馈库上限
        this.gamma = 0.95;  // 降低长期视域，让模型更关注眼前的仙人掌（尤其是超小batch时更有利于快速拟合）
        
        if (this.isDemo) {
            this.epsilon = 0.0;
            this.epsilonMin = 0.0;
            this.epsilonDecay = 1.0;
            this.speedMultiplier = 1; // 演示模式不加速
        } else {
            // 分布式 Actors 统一从 1.0 开始探索，但是衰减速度（decay）各不同
            // 以形成技能梯队：有的迅速变聪明专注冲高分（剥削），有的长期瞎跳挖掘新坑（探索）
            this.epsilon = 0.2; // 继承优良血统，探索率大幅下降！
            this.epsilonMin = 0.01; // 保持最低限度探索，防止完全死板
            this.speedMultiplier = 5; // 进一步放慢Actor的倍速（从15降到5）。
            
            if (this.isActor) {
                // 修复：针对16维的高分位空间，调慢分布式探测的衰减
                let rand = Math.random();
                if (rand < 0.25) this.epsilonDecay = 0.995;         
                else if (rand < 0.5) this.epsilonDecay = 0.996;     
                else if (rand < 0.75) this.epsilonDecay = 0.998;    
                else this.epsilonDecay = 0.999;                    
            } else {
                // ⚠️修复: 由于状态空间扩充至 16维，环境识别难度成倍上升。
                // 如果按之前的速度衰减，网络根本没见多看过几次成功越障的样本就被“锁死”了（陷入疯狂碰瓷的局部最优）。
                this.epsilonDecay = 0.99; 
            }
        }
        
        this.isExamMode = false; // 新增：考试模式（无探索）标识
        this.batchSize = 128; 
        this.currentLoss = 0.0;
        
        // 核心超光速引擎！
        this.isFastForward = false;
        this.fakeTime = performance.now();
        
        this.lastAction = 0;
        this.lastState = null;
        this.trainingStartTime = 0; 
        this.interval = null;

        // RL 进阶机制：跳桢 (Frame Skip) 与 后台高频特训
        this.frameCount = 0;
        this.frameSkip = 4; // 维持一个动作 4 帧（约100毫秒），防止一直鬼畜打断“起跳”
        this.isReplaying = false;

        this.initModel();
        this.setupTimeHacks();
        this.setupUI();
        
        // --- iframe postMessage 跨域事件监听 ---
        // 每秒向父窗口汇报当前分数
        setInterval(() => {
            if (this.isActor && window.parent && this.runner && this.runner.playing && !this.runner.crashed) {
                let realScore = this.runner.distanceMeter ? this.runner.distanceMeter.getActualDistance(Math.ceil(this.runner.distanceRan)) : Math.ceil(this.runner.distanceRan);
                if (!window.actorId) window.actorId = Math.random().toString(36).substring(2);
                window.parent.postMessage({
                    type: 'ACTOR_CURRENT_SCORE',
                    actorId: window.actorId,
                    score: realScore
                }, '*');
            }
        }, 1000);

        window.addEventListener('message' , (event) => {
            if ((this.isDemo || this.isActor) && event.data && event.data.type === 'RL_WEIGHTS_SYNC') {
                // 如果是训练节点(Actor)，大脑随便怎么被覆盖都行，反正是打工人
                if (this.isActor) {
                    this.applyWeightsFromData(event.data);
                } 
                // 如果是演示中心(Demo)，一局之内大脑绝对不允许被热更新替换，必须死后重开时换上新脑
                else if (this.isDemo) {
                    this.pendingWeightsEventData = event.data;
                    if (this.runner && this.runner.playing && !this.runner.crashed) {
                        let realScore = this.runner.distanceMeter ? this.runner.distanceMeter.getActualDistance(Math.ceil(this.runner.distanceRan)) : Math.ceil(this.runner.distanceRan);
                        if (typeof this.lastDemoUpdateScore === 'undefined') this.lastDemoUpdateScore = 0;
                        if (realScore - this.lastDemoUpdateScore >= 400) {
                            this.applyWeightsFromData(this.pendingWeightsEventData);
                            this.pendingWeightsEventData = null;
                            this.lastDemoUpdateScore = realScore;
                        }
                    }
                }
            } else if (event.data && event.data.type === 'START_ACTOR') {
                if (this.isActor) {
                    let b1 = document.getElementById('btn-toggle-train');
                    if (b1 && !this.isTraining) b1.click();
                } else if (this.isDemo) {
                    let b2 = document.getElementById('btn-start-demo');
                    if (b2 && !this.isTraining) b2.click();
                }
            } else if (event.data && event.data.type === 'PAUSE_ACTOR') {
                // 收到全集群暂停指令
                if (this.isActor) {
                    let b1 = document.getElementById('btn-toggle-train');
                    if (b1 && this.isTraining) b1.click();
                } else if (this.isDemo) {
                    // Demo节点实际上通过 btn-demo 点击会触发取消
                    if (this.isTraining) {
                        this.isTraining = false;
                        if (this.runner && this.runner.playing) {
                            // 暴力制止画面流转
                            this.runner.stop();
                        }
                    }
                }
            } else if (event.data && event.data.type === 'RESUME_ACTOR') {
                // 收到全集群恢复指令
                if (this.isActor) {
                    let b1 = document.getElementById('btn-toggle-train');
                    if (b1 && !this.isTraining) b1.click();
                } else if (this.isDemo) {
                    if (!this.isTraining) {
                        let b2 = document.getElementById('btn-start-demo');
                        if (b2) b2.click();
                    }
                }
            }
        });
    }

        async initModel() {

        // 对于极小模型，CPU 后端的同步推演速度远超 WebGL，不会引发 dataSync 锁死主线程！
        await tf.setBackend('cpu');
        
        this.model = tf.sequential();
        this.model.add(tf.layers.dense({ units: 64, inputShape: [this.stateSize], activation: 'relu' }));
        this.model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
        this.model.add(tf.layers.dense({ units: this.actionSize, activation: 'linear' }));
        
        try {
            let slModel = await tf.loadLayersModel('localstorage://sl_pretrained_model');
            let slW = slModel.getWeights();
            let rlW = this.model.getWeights();
            if (slW.length >= 4 && rlW.length >= 4) {
                rlW[0] = slW[0]; rlW[1] = slW[1]; 
                rlW[2] = slW[2]; rlW[3] = slW[3];
                try { rlW[4] = slW[4]; rlW[5] = slW[5]; } catch(e) {}
                this.model.setWeights(rlW);
                console.log("【继承】前端Actor成功继承实验2模型！");
                this.epsilon = 0.2; // 确保加载到大脑的情况下再降低探索率
            }
        } catch(e) {
            console.log("无预训练模型，从零开始");
        }

        // 方案三：提升基础学习率（Learning Rate）加快网络认知
        this.model.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' }); 

        // 引入 Target Network 解决学习过程中的震荡和不收敛！
        this.targetModel = tf.sequential();
        this.targetModel.add(tf.layers.dense({ units: 64, inputShape: [this.stateSize], activation: 'relu' }));
        this.targetModel.add(tf.layers.dense({ units: 32, activation: 'relu' }));
        this.targetModel.add(tf.layers.dense({ units: this.actionSize, activation: 'linear' }));
        this.targetModel.setWeights(this.model.getWeights());
(this.model.getWeights());
        
        this.updateTargetCounter = 0;
        
        if (this.isDemo) {
            this.loadWeights();
        }
    }

    // --- 新增：跨页面/局间权重同步存取 ---
    saveWeights() {
        const weights = this.model.getWeights().map(w => w.arraySync());
        const dataPayload = {
            weights: weights,
            episodes: this.episodes,
            highestScore: this.highestScore
        };

        // 1. 本地存储（旧方案）
        localStorage.setItem('trex_best_weights', JSON.stringify(dataPayload));
        
        // 2. postMessage iframe 通信（新方案：推向上面的父容器 rl_dashboard.html）
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'MODEL_UPDATE',
                ...dataPayload
            }, '*');
        }
    }

    loadWeights() {
        const dataStr = localStorage.getItem('trex_best_weights');
        if (dataStr) {
            try {
                this.applyWeightsFromData(JSON.parse(dataStr));
            } catch(e) {
            }
        }
    }
    
    // 把更新权重的逻辑单独抽出来，方便 postMessage 调用
    applyWeightsFromData(data) {
        if (!data || !data.weights) return;
        try {
            const currentWeights = this.model.getWeights();
            const newTensors = data.weights.map((wArr, i) => tf.tensor(wArr, currentWeights[i].shape));
            this.model.setWeights(newTensors);
            this.targetModel.setWeights(newTensors);
            
            // 同步代数和最高分
            this.episodes = data.episodes || this.episodes; 
            this.highestScore = Math.max(this.highestScore, data.highestScore || 0);
            
            this.updateUI(); // 收到消息后立即刷新 UI
        } catch(e) {
        }
    }

    updateTarget() {
        this.targetModel.setWeights(this.model.getWeights());
    }

    // 从原版DOM实机抽吸严丝合缝的状态! (已与监督学习16维状态对齐)
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
            Math.min(1.0, Math.max(0.0, speed / 30.0)),
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
            this.runner.tRex.jumping ? 0.0 : 1.0
        ];
    }

    act(state) {
        let speed = state[0] * 30.0;
        let e1d = state[1] * 800.0;
        let e1y = state[3] * 150.0;
        let isGrounded = state[15];

        // 🌟 核心升华：引入实验1的符号主义兜底规则 (AEB自动紧急避免) 🌟
        let emergencyAction = null;
        let forceGrounded = false; // 戒备区保底
        
        // 修正：从恐龙头部算距离 (大概减去恐龙自身宽度 44)
        let actualDistance = e1d - 44; 
        let framesToEnemy = actualDistance / (speed || 1);
        
        // 当敌人在正前方的反应区间内：极度危险，必须动作！
        // 🚨 重大修复：将防撞网（兜底）极限后撤！
        // 绝不能在 15 帧那么早的地方就强制起跳，高速情况下距离太远，抛物线必定提前落地砸死在连排仙人掌上。
        // 将紧急接管线设定在 8 帧（无限逼近实验1的原则），把广阔空间还给深度学习网络自己去决策！
        if (actualDistance > -50 && framesToEnemy < 8) { 
            // 危险临近生死线！触发强制兜底
            if (e1y < 80) { 
                // 翼龙较高，必须趴下
                emergencyAction = 2; 
            } else {
                // 仙人掌或低处翼龙，必须起跳
                if (isGrounded === 1.0) {
                    emergencyAction = 1; 
                } else {
                    emergencyAction = 0; // 在空中时保持当前状态不乱按
                }
            }
        } else if (actualDistance > -50 && framesToEnemy < 25) {
            // ⚠️ 戒备区：敌人已进入视野，防止为了吃闲杂金币而在马上要跳仙人掌前起跳
            forceGrounded = true;
        }

        // 探索期（Epsilon机制）：盲目探索，它的主要任务是“偶然发现金币”
        if (!this.isExamMode && Math.random() <= this.epsilon) {
            // 如果AEB要求保命，绝对服从！
            if (emergencyAction !== null) return emergencyAction;
            
            // 戒备区：收起玩心，乖乖在地上跑，给接下来的起跳动作留足起手空间
            if (forceGrounded) return 0;
            
            // 绝对安全期：有充分的时间试错，20%概率尝试瞎弹跳来偶然吃到金币
            return Math.random() < 0.2 ? 1 : 0;
        }
        
        // 强化学习决策（利用期）
        return tf.tidy(() => {
            const qs = this.model.predict(tf.tensor2d([state])).dataSync();
            let qsArr = Array.from(qs);

            // ⚠️ 工业级混合大模型架构：规则保命 + AI寻优
            if (emergencyAction !== null) {
                // 强制接管：抹杀所有违背生命安全的动作
                for(let i=0; i<this.actionSize; i++) {
                    if (i !== emergencyAction) qsArr[i] -= 9999;
                }
            } else if (forceGrounded) {
                // 戒备区压制：强制神经网络收心，就算这时候天上有金币也不准跳！
                qsArr[1] -= 9999;
                qsArr[3] -= 9999;
            } else {
                // 在绝对安全区间，没有羁绊：如果网络判定“上面有金币，跳起来分数多”，听它的！
            }
            
            // 基础物理限制（绝对禁飞）
            if (isGrounded === 0.0) {
                qsArr[1] -= 999;
                qsArr[3] -= 999;
            }

            let maxVal = -Infinity;
            let bestAction = 0;
            for(let i=0; i<this.actionSize; i++) {
                if (qsArr[i] > maxVal) {
                    maxVal = qsArr[i];
                    bestAction = i;
                }
            }
            return bestAction;
        });
    }

    // 通过调用原版DOM键盘事件方法来操纵恐龙动作，百分之百还原真实人类防作弊。
    takeAction(action) {
        if (!this.runner || !this.runner.tRex) return;
        
        let isJumping = this.runner.tRex.jumping;
        let isDucking = this.runner.tRex.ducking;
        
        if (action === 1 || action === 3) { // 长跳或短跳
            if (isDucking) {
                this.runner.tRex.setDuck(false);
            }
            if (!isJumping && !this.runner.tRex.ducking) {
                this.runner.tRex.startJump(this.runner.currentSpeed);
                // ⚠️重大修复: 绝对不能在 50倍速的物理环境里使用真实时间的 setTimeout！
                // 这会导致前面累积的下落指令在后期的某一局里集中爆发，在平地上空把起跳的恐龙瞬间按死。
                // 解决方案：RL大脑有着微秒级的反应神经，如果它想短跳，让它在下一帧起自己去学会按 2（下蹲）来加速坠落即可，它比人聪明得多，这里只需统一处理起跳。
            }
        } else if (action === 2) { // 趴下
            if (isJumping) {
                this.runner.tRex.setSpeedDrop();
            } else if (!isDucking) {
                this.runner.tRex.setDuck(true);
            }
        } else { // 原地走
            if (isDucking) {
                this.runner.tRex.setDuck(false);
            }
        }
        
        this.lastAction = action;
    }

    remember(state, action, reward, nextState, done) {
        let exp = {state, action, reward, nextState, done};
        
        // 如果是纯采集的 Actor 节点，我们就把数据放到局专用的数组里即可
        if (this.isActor) {
            this.episodeMemory.push(exp);
            if (reward > 20) {
                for (let i = this.episodeMemory.length - 2; i >= Math.max(0, this.episodeMemory.length - 60); i--) {
                    if (this.episodeMemory[i].action === 1 || this.episodeMemory[i].action === 3) {
                        this.episodeMemory[i].reward += 50.0;
                        break;
                    }
                }
            }
            return;
        }
        
        this.memory.push(exp);
        if (this.memory.length > this.maxMemory) {
            this.memory.shift(); 
        }
        
        // 飞行物(翼龙)的判定：因为归一化了 obsY1/150，所以在实际游戏中翼龙的位置 Y1 < 90
        // 等价于 state[3] < 0.6 是翼龙高度 (目前 y / 150)。
        if (state[3] < 0.6 || state[6] < 0.6 || state[9] < 0.6) {
            this.flyMemory.push(exp);
            if (this.flyMemory.length > this.maxFlyMemory) {
                this.flyMemory.shift();
            }
        }
        
        // 任何负反馈或死亡单独存一份
        if (reward < 0 || done) {
            this.badMemory.push(exp);
            if (this.badMemory.length > this.maxBadMemory) {
                this.badMemory.shift();
            }
        }

        if (reward > 20) {
            for (let i = this.memory.length - 2; i >= Math.max(0, this.memory.length - 60); i--) {
                if (this.memory[i].action === 1 || this.memory[i].action === 3) {
                    this.memory[i].reward += 50.0;
                    this.goodMemory.push(this.memory[i]);
                    break;
                }
            }
            this.goodMemory.push(exp);
            while (this.goodMemory.length > this.maxGoodMemory) {
                this.goodMemory.shift();
            }
        }
    }

    async replay() {
        if (this.memory.length < this.batchSize || this.isReplaying) {
            return;
        }
        this.isReplaying = true;

        // 必须增加 trycatch，否则报错会永久卡死 this.isReplaying 状态
        try {
            let batch = [];
            for (let i = 0; i < this.batchSize; i++) {
                batch.push(this.memory[Math.floor(Math.random() * this.memory.length)]);
            }
            
            // 强力对抗灾难性遗忘：从 badMemory 里抽取至少四分之一的数据，确保不要"忘了痛"
            if (this.badMemory && this.badMemory.length > 0) {
                let badSampleCount = Math.min(32, this.badMemory.length);
                for(let i=0; i<badSampleCount; i++) {
                    batch[i] = this.badMemory[Math.floor(Math.random() * this.badMemory.length)]; // 总是拿强烈的碰撞/扣分教训覆盖前面一部分
                }
            }
            
            // 强化抗灾难性遗忘：专属注入"对抗翼龙"的经验！给 20% 的名额(约25个样本)留给翼龙
            if (this.flyMemory && this.flyMemory.length > 0) {
                let flySampleCount = Math.min(25, this.flyMemory.length);
                // 把翼龙样本塞到 batch 的尾部（前32个给了错题，中间随机，后面给翼龙）
                for (let i = 0; i < flySampleCount; i++) {
                    let insertIdx = (this.batchSize - 1) - i;
                    batch[insertIdx] = this.flyMemory[Math.floor(Math.random() * this.flyMemory.length)];
                }
            }
            
            // 强化正向刺激：从 goodMemory 抽取名额
            if (this.goodMemory && this.goodMemory.length > 0) {
                let goodSampleCount = Math.min(25, this.goodMemory.length);
                for (let i = 0; i < goodSampleCount; i++) {
                    let insertIdx = 32 + i; 
                    batch[insertIdx] = this.goodMemory[Math.floor(Math.random() * this.goodMemory.length)]; 
                }
            }

            const states = batch.map(b => b.state);
            const nextStates = batch.map(b => b.nextState);

            // 使用异步 API 防止阻塞主线程导致卡死
            const statesT = tf.tensor2d(states);
            const nextStatesT = tf.tensor2d(nextStates);
            
            const currentQsT = this.model.predict(statesT);
            const nextQsT = this.targetModel.predict(nextStatesT);

            const currentQsArr = await currentQsT.array();
            const nextQsArr = await nextQsT.array();

            statesT.dispose();
            nextStatesT.dispose();
            currentQsT.dispose();
            nextQsT.dispose();

            let x = [];
            let y = [];

            for (let i = 0; i < this.batchSize; i++) {
                let target = batch[i].reward;
                if (!batch[i].done) {
                    target = batch[i].reward + this.gamma * Math.max(...nextQsArr[i]);
                }
                let targetF = currentQsArr[i];
                targetF[batch[i].action] = target;
                x.push(batch[i].state);
                y.push(targetF);
            }

            // 让出主线程，给 UI 喘息刷新的机会
            await tf.nextFrame();

            const xT = tf.tensor2d(x);
            const yT = tf.tensor2d(y);
            const res = await this.model.fit(xT, yT, { epochs: 1, verbose: 0 });
            this.currentLoss = res.history.loss[0];
            
            this.updateTargetCounter++;
            if (this.updateTargetCounter > 500) { // 第500次训练（约 40 秒真机时间）才覆盖一次Target，避免自身预期过度震荡导致遗忘
                if (this.targetModel && this.model) {
                    this.updateTarget();
                    this.updateTargetCounter = 0;
                }
            }

            xT.dispose();
            yT.dispose();

        } catch(e) {
        } finally {
            this.isReplaying = false;
        }
    }

    // 核心科技：拦截实机时间轴和帧！
    setupTimeHacks() {
        let ai = this;
        let originalPerfNow = performance.now.bind(performance);
        let originalSchedule = window.Runner.prototype.scheduleNextUpdate;
        let originalUpdate = window.Runner.prototype.update;
        let originalVis = window.Runner.prototype.onVisibilityChange;

        ai.timeOffset = 0;
        ai.syncRealTime = function() {
            ai.timeOffset = ai.fakeTime - originalPerfNow();
        };

        // 0. 接管切后台暂停机制！
        window.Runner.prototype.onVisibilityChange = function(e) {
            if (ai.isTraining) return; // 挂机训练/自动演示期间如果且后台，不要呼叫 this.stop() 阻断当前流程
            if (originalVis) originalVis.call(this, e);
        };

        // 1. 我们接管原生时间获取。引擎获取到的时间，由我们进行操控！
        performance.now = function () {
            if (ai.isTraining && ai.isFastForward) {
                return ai.fakeTime;
            }
            return originalPerfNow() + ai.timeOffset;
        };

        // 2. 接管 requestAnimationFrame 的心跳控制
        window.Runner.prototype.scheduleNextUpdate = function () {
            // 如果我们自己正在执行批量速刷，禁止内部递归生成新的排期回调，阻止指数级帧裂变炸弹（Fork Bomb）
            if (ai._isInsideBatch) return;

            // 如果是在快速训练模式下，我们直接接管下一帧的执行逻辑
            if (ai.isTraining && ai.isFastForward) {
                if (!this.updatePending) {
                    this.updatePending = true;
                    // 页面不激活会导致 requestAnimationFrame 暂停，改为用 setTimeout 接管后台挂机
                    let scheduler = document.hidden ? (cb) => setTimeout(cb, 10) : requestAnimationFrame;
                    scheduler(function () {
                        if (!ai.isTraining || !ai.isFastForward) {
                            this.update(); 
                            return;
                        }
                        
                        // 当跑到后台被降发为 1000ms 每帧时，加大批处理量防止掉速
                        let currentBatchSteps = ai.speedMultiplier * (document.hidden ? 10 : 1); // 后台挂机时批量计算量也适当压半，减少浏览器风扇狂转
                        
                        // 标记开始批量刷帧
                        ai._isInsideBatch = true;

                        try {
                            // 光速大循环：我们在一个物理帧里强行算出几十次未来！
                            while(currentBatchSteps > 0 && ai.isTraining && !this.crashed && this.playing) {
                                ai.fakeTime += 16;   // 手动给怀表拨快16毫米
                                this.update();       // 调用原版 update
                                currentBatchSteps--;
                            }
                        } finally {
                            // 标记批量结束
                            ai._isInsideBatch = false;
                        }

                        // 无条件复位，防止死锁
                        this.updatePending = false; 

                        // 如果这一百轮折腾完了它还活着
                        if (!this.crashed && this.playing) {
                            // 原版 update 已经在上面最后一次循环里完成了绘制
                            // 我们不需要重新调用不存在的 draw 方法，直接接力即可！
                            
                            // 下一帧光速继续！
                            this.scheduleNextUpdate(); 
                        }
                        // 备注：如果在这几轮当中撞死了(this.crashed 为 true)，循环会跳出，原生的游戏流程会介入，进行闪烁死亡界面和重新开始。
                    }.bind(this));
                }
            } else {
                originalSchedule.call(this); // 如果没有加速，乖乖走原生的 1倍速物理排期
            }
        };

        // 3. 将 RL 大脑训练塞入原版 update 管线
        window.Runner.prototype.update = function () {
            let wasPlaying = this.playing;
            
            // 真实物理实机滚动！！
            originalUpdate.call(this);

            if (ai.isTraining && this.activated && !this.playingIntro && wasPlaying) {
                let done = this.crashed;
                
                ai.frameCount++;
                let shouldAct = (ai.frameCount % ai.frameSkip === 0) || done;

                if (shouldAct) {
                    let currentState = ai.getState();
                    
                    // 计算目前分数，作为奖励结算基准
                    let currentScore = 0;
                    if (this.distanceMeter) {
                        currentScore = this.distanceMeter.getActualDistance(Math.ceil(this.distanceRan));
                    } else {
                        currentScore = Math.ceil(this.distanceRan);
                    }
                    
                    // 基于游戏真实分差给出平滑或暴击奖励 (活着有小分，吃金币瞬间获得50分)
                    // ai.lastScore 需要在实例里初始化或者在这直接附个默认值
                    if (typeof ai.lastScore === 'undefined') ai.lastScore = 0;
                    let rawReward = currentScore - ai.lastScore;
                    ai.lastScore = currentScore;
                    
                    let reward = rawReward; 
                    
                    if (done) {
                        // 【防止梯度爆炸补丁】
                        // 原先“死时扣除当前得分一半”在几万分时会导致惩罚高达 -20000
                        // 如此巨大的目标值产生上亿的 MSE Loss，会一拳把优化器干碎，导致权重全部退化！
                        // 修正：将死亡惩罚限制在 -100 到 -1000 的安全区间内
                        reward = - Math.min(500.0, Math.max(50.0, currentScore / 5.0)); 
                    } else {
                        // 依然保留神级动作的额外奖励（极速坠落）
                        if (ai.lastState && ai.lastState[1] < 0.15 && currentState[1] > ai.lastState[1] + 0.3) {
                            if (ai.lastState[15] === 0.0 && ai.lastAction === 2) {
                                reward += 5.0; // 极速落地得分额外嘉奖
                            }
                        }
                    }

                    // 如果上一个状态存在，且这一步我们做出了动作，才记忆
                    if (ai.lastState != null) {
                        // 修正：由于 frameSkip=4，回溯 6 个记忆周期即可覆盖过去的 ~24 物理帧，避免牵连无辜的正确决策！
                        if (done) {
                            let memTarget = ai.isActor ? ai.episodeMemory : ai.memory;
                            let n = Math.min(6, memTarget.length);
                            for (let i = 0; i < n; i++) {
                                let pastMem = memTarget[memTarget.length - 1 - i];
                                pastMem.reward -= 10.0; // 进行深度连带罚分，死前最后几步也狠狠扣分
                                // 发掘出真正的致死动作，加入黑名单！
                                if (!ai.isActor) {
                                    ai.badMemory.push(pastMem);
                                }
                            }
                            if (!ai.isActor) {
                                while (ai.badMemory.length > ai.maxBadMemory) {
                                    ai.badMemory.shift();
                                }
                            }
                        }
                        ai.remember(ai.lastState, ai.lastAction, reward, currentState, done);
                    
                    // 【防沉迷/防卡死更新补丁】
                    // 如果 Actor 存活太久（记忆积累超过 500 条），主动将之前的部分经验上报
                    // 留下末尾 20 条防备死亡时用来追溯惩罚
                    if (ai.isActor && !done && ai.episodeMemory && ai.episodeMemory.length > 500) {
                        let toSend = ai.episodeMemory.splice(0, ai.episodeMemory.length - 20);
                        if (window.parent) {
                            try {
                                window.parent.postMessage({
                                    type: 'EPISODE_BATCH', 
                                    actorId: ai.actorId || window.actorId,
                                    score: currentScore,
                                    experiences: JSON.parse(JSON.stringify(toSend))
                                }, '*');
                            } catch(e) {}
                        }
                    }
                    }

                    if (done) {
                        // 死掉了！
                        ai.episodes++;
                        
                        // 每 10 局设定为一次大考（完全凭本事跑，不瞎探索），确保能遇到后期的翼龙
                        ai.isExamMode = (ai.episodes % 10 === 0);
                        
                        // 计算真实的得分 (换算前是 float 的 distanceRan)
                        let realScore = 0;
                        if (this.distanceMeter) {
                            realScore = this.distanceMeter.getActualDistance(Math.ceil(this.distanceRan));
                        } else {
                            realScore = Math.ceil(this.distanceRan);
                        }

                        // 方案三：超过阈值分数后触发断崖式收敛（Epsilon 强制归零）
                        if (realScore > 500) {
                            ai.epsilonMin = 0.01;      // 最低保留极少探测
                            if (ai.epsilon > 0.05) {
                                ai.epsilon = 0.05;     // 直接收心，变为专注利用期
                            }
                            ai.epsilonDecay = 0.99;    // 极其平缓地继续降到0.01
                        } else {
                            // 否则按正常的衰减速度衰减
                            if (ai.epsilon > ai.epsilonMin) {
                                ai.epsilon *= ai.epsilonDecay;
                            }
                        }

                        if (realScore > ai.highestScore) {
                            ai.highestScore = realScore;
                        }
                        
                        // 记录近期10局的分数
                        ai.recentScores.push(realScore);
                        if (ai.recentScores.length > 10) {
                            ai.recentScores.shift();
                        }
                        
                        ai.lastState = null;
                        ai.lastScore = 0; // 重置上一局分数记录，防止负分差
                        
                        // 死掉后分离处理：训练模式存脑，展示模式拿脑
                        if (ai.isActor) {
                            if (ai.episodeMemory.length > 0 && window.parent) {
                                try {
                                    // 使用 JSON 深度序列化，彻底杜绝 DataCloneError (WebGL或Tensor残留导致) 造成的 postMessage 失败
                                    window.parent.postMessage({
                                        type: 'EPISODE_BATCH', actorId: ai.actorId || window.actorId,
                                        score: realScore,
                                        experiences: JSON.parse(JSON.stringify(ai.episodeMemory))
                                    }, '*');
                                    ai.episodeMemory = [];
                                } catch(e) {
                                }
                            }
                        } else if (!ai.isDemo) {
                            ai.saveWeights(); // 将这一代的大脑存入 localStorage
                        } else {
                            if (window.parent) {
                                window.parent.postMessage({
                                    type: 'DEMO_SCORE',
                                    score: realScore
                                }, '*');
                            }
                            // ai.loadWeights(); // 演示节点由主宰不断下发权重同步，不读本地缓存
                        }

                        // 无论当前是否由于批处理陷入 async promise，直接挂一个脱离调度的重启宏任务
                        if (ai.isTraining) {
                            setTimeout(() => {
                                // 复活前清除所有按键状态、重置计时器，绕过 raqId 卡死
                                ai.runner.crashed = false;
                                if (ai.runner.raqId) {
                                    cancelAnimationFrame(ai.runner.raqId);
                                    ai.runner.raqId = 0;
                                }
                                // 重启前，如果是演示节点，取回最新的待办大脑换上
                                if (ai.isDemo) {
                                    ai.lastDemoUpdateScore = 0;
                                    if (ai.pendingWeightsEventData) {
                                        ai.applyWeightsFromData(ai.pendingWeightsEventData);
                                        ai.pendingWeightsEventData = null;
                                    }
                                }
                                ai.runner.restart();
                                ai.runner.tRex.xPos = 50; // 修复：防止下蹲死亡时游戏引擎会自动累加xPos导致恐龙不断向右漂移
                            }, ai.isFastForward ? 1 : 500);
                        }

                        // 后台继续保存/消化记忆
                        if (!ai.isActor && !ai.isReplaying) {
                            ai.replay().finally(() => {
                                ai.updateUI();
                            });
                        } else if (ai.isActor) {
                            ai.updateUI();
                        }
                        
                    } else {
                        // 活着，判断下一个动作
                        ai.lastState = currentState;
                        ai.lastAction = ai.act(currentState);
                        ai.takeAction(ai.lastAction);
                        
                        // 高频后台偷偷学习
                        if (!ai.isActor && !ai.isReplaying && ai.memory.length >= ai.batchSize && ai.frameCount % (ai.frameSkip * 25) === 0) {
                            ai.replay();
                        }
                    }
                }
            }
        };
    }

    setupUI() {
        let oldPanel = document.getElementById('ai-panel');
        if(oldPanel) oldPanel.remove();

        const style = document.createElement('style');
        // 为了适应双层 iframe，调小控制面板，并放右上角
        style.innerHTML = `
            #ai-panel { position: fixed; top: 10px; right: 10px; background: rgba(248, 249, 250, 0.9); padding: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); font-family: monospace; font-size: 12px; z-index: 10000; color: #333; min-width: 300px; text-align: left; }
            .stat-row { margin: 4px 0; }
            .val { font-weight: bold; color: #0066cc; }
            #ai-status { color: #e74c3c; font-weight: bold; }
            button { padding: 4px 8px; margin: 4px 2px 0; cursor: pointer; font-family: inherit; border: 1px solid #999; background: #eee; border-radius: 4px; font-weight: bold; font-size: 11px; }
            button:hover { background: #ddd; }
            #btn-start { background-color: #e3f2fd; border-color: #90caf9; }
            #btn-pause { background-color: #fff3e0; border-color: #ffcc80; }
            #btn-demo { background-color: #f3e5f5; border-color: #ce93d8; }
            .demo-link { font-weight: bold; color: #2980b9; text-decoration: none; background: #ffeaa7; padding: 4px 8px; border-radius: 4px; border: 1px solid #fdcb6e; margin-left: 5px; display: inline-block; font-size: 11px; }
            .demo-link:hover { background: #fdcb6e; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'ai-panel';
        
        // 由于有父级 dashboard 的标题，这里的提示可以简化
        let titleHtml = this.isDemo ? '⭐ 演示模式控制' : (this.isActor ? '⚙️ 高速采集 Actor' : '⚙️ 训练模式控制');
        
        panel.innerHTML = `
            <div style="font-weight:bold; font-size:14px; margin-bottom:6px;">${titleHtml}</div>
            <div class="stat-row">
                状态: <span id="ai-status">待命</span> | 局数: <span id="ai-eps" class="val" style="color: red;">0</span>
            </div>
            <div class="stat-row">
                最高: <span id="ai-high" class="val" style="color: red;">0</span> | 近10平均: <span id="ai-avg10" class="val" style="color: #27ae60;">0</span>
            </div>
            ${this.isDemo ? '' : `
            <div class="stat-row" style="color: #555;">
                Epsilon: <span id="ai-epsilon" class="val">1.000</span> | 模式: <span id="ai-exam" class="val" style="color:#d35400;">日常试错</span>
            </div>
            <div class="stat-row" style="color: #555;">
                记忆库: <span id="ai-mem" class="val">0</span> | 纯翼龙槽: <span id="ai-fly-mem" class="val">0</span>
            </div>
            <div class="stat-row" style="color: #555;">
                Loss: <span id="ai-loss" class="val">0.000</span> | 用时: <span id="ai-time" class="val" style="color: #d35400;">0s</span>
            </div>
            `}
            <div style="margin-top: 8px;" id="ai-controls">
            </div>
        `;
        document.body.appendChild(panel);
        
        const controls = document.getElementById('ai-controls');
        if (this.isDemo) {
            controls.innerHTML = `
                <button id="btn-start-demo">开始全自动演示</button>
            `;
            document.getElementById('btn-start-demo').addEventListener('click', () => {
                this.isFastForward = false; 
                this.isTraining = true;
                document.getElementById('ai-status').innerText = '读取神识，全自动避障中...';
                document.getElementById('ai-status').style.color = '#9b59b6';
                if (this.runner.crashed) {
                    this.runner.restart();
                    this.runner.tRex.xPos = 50;
                } else if (this.runner.paused) {
                    this.runner.play(); // 恢复原生游戏循环
                } else if (!this.runner.playing) {
                    // 直接越过 CSS 动画和 DOM 事件，强制开启实机物理！
                    this.runner.playing = true;
                    this.runner.tRex.jumpCount = 1; // 欺骗引擎不再触发 playIntro 动画
                    this.runner.activated = true;
                    this.runner.playingIntro = false;
                    this.runner.tRex.playingIntro = false;
                    this.runner.tRex.xPos = 50;
                    this.runner.startGame();
                    if (!this.runner.tRex.jumping && !this.runner.tRex.ducking) {
                        this.runner.tRex.startJump(this.runner.currentSpeed);
                    }
                }
                this.runner.scheduleNextUpdate();
                if(!this.interval) this.interval = setInterval(() => this.updateUI(), 300);
            });
        } else {
            controls.innerHTML = `
                <button id="btn-toggle-train">开始加速训练</button>
                <button id="btn-demo">纯预测演示(不再随机)</button>
                <a href="rl.html?mode=demo" target="_blank" class="demo-link">👉 开启演示子窗口 (局间同步大脑)</a>
                <a href="index.html" class="demo-link" style="background:#e8f8f5; border-color:#a9dfbf; color:#27ae60;">🏠 返回主菜单</a>
            `;
            
            document.getElementById('btn-toggle-train').addEventListener('click', (e) => {
                e.target.blur();
                const btn = document.getElementById('btn-toggle-train');
                if (!this.isTraining || !this.isFastForward) {
                    this.isTraining = true;
                    this.isFastForward = true;
                    this.fakeTime = performance.now();
                    if (this.trainingStartTime === 0) this.trainingStartTime = Date.now();
                    
                    document.getElementById('ai-status').innerText = '纯后台加速训练中 (主脑同步开启)';
                    document.getElementById('ai-status').style.color = '#27ae60';
                    btn.innerText = '暂停训练';
                    
                    if (this.runner.crashed) {
                        this.runner.restart();
                        this.runner.tRex.xPos = 50;
                    } else if (this.runner.paused) {
                        this.runner.play(); // 恢复原生游戏循环
                    } else if (!this.runner.playing) {
                        // 直接越过 CSS 动画和 DOM 事件，强制开启实机物理！
                        this.runner.playing = true;
                        this.runner.tRex.jumpCount = 1; // 欺骗引擎不再触发 playIntro 动画
                        this.runner.activated = true;
                        this.runner.playingIntro = false;
                        this.runner.tRex.playingIntro = false;
                        this.runner.tRex.xPos = 50;
                        this.runner.startGame();
                        if (!this.runner.tRex.jumping && !this.runner.tRex.ducking) {
                            this.runner.tRex.startJump(this.runner.currentSpeed);
                        }
                    }
                    
                    this.runner.scheduleNextUpdate();
                    if(!this.interval) this.interval = setInterval(() => this.updateUI(), 300);
                } else {
                    if (this.isFastForward) this.syncRealTime(); // 降维之前，把虚假流逝的光阴缝合到现实
                    this.isFastForward = false;
                    this.isTraining = false;
                    
                    if (this.runner && this.runner.playing) {
                        this.runner.stop(); // 暂停真正的物理世界，防止撞死
                    }
                    
                    document.getElementById('ai-status').innerText = '已暂停';
                    document.getElementById('ai-status').style.color = '#e74c3c';
                    btn.innerText = '开始加速训练';
                }
            });

            document.getElementById('btn-demo').addEventListener('click', (e) => {
                e.target.blur();
                if (this.isFastForward) this.syncRealTime(); // 缝合时间线，防止引擎崩溃
                this.isFastForward = false; 
                this.isTraining = true; 
                if(this.epsilon > 0.01) this.epsilon = 0.01; 
                document.getElementById('ai-status').innerText = '纯预测演示(1倍速)';
                document.getElementById('ai-status').style.color = '#9b59b6';
                
                if (this.runner.crashed) {
                    this.runner.restart();
                    this.runner.tRex.xPos = 50;
                } else if (!this.runner.playing) {
                    // 直接强制越过 CSS 动画
                    this.runner.playing = true;
                    this.runner.tRex.jumpCount = 1; // Hack: bypass playIntro
                    this.runner.activated = true; 
                    this.runner.playingIntro = false;
                    this.runner.tRex.playingIntro = false;
                    this.runner.tRex.xPos = 50;
                    this.runner.startGame();
                    if (!this.runner.tRex.jumping && !this.runner.tRex.ducking) {
                        this.runner.tRex.startJump(this.runner.currentSpeed);
                    }
                }
                
                this.runner.scheduleNextUpdate();
            });
        }
    }

    updateUI() {
        if(!document.getElementById('ai-eps')) return;
        document.getElementById('ai-eps').innerText = this.episodes;
        document.getElementById('ai-high').innerText = this.highestScore;
        
        if (this.recentScores.length > 0) {
            let sum = this.recentScores.reduce((a, b) => a + b, 0);
            let avg = Math.round(sum / this.recentScores.length);
            let min = Math.min(...this.recentScores);
            document.getElementById('ai-avg10').innerText = avg;
            document.getElementById('ai-min10').innerText = min;
        }

        if (!this.isDemo) {
            document.getElementById('ai-epsilon').innerText = this.epsilon.toFixed(3);
            let modeText = '🧪 日常试错';
            if (this.isExamMode) modeText = '🚨 期末考试(无探索)';
            if (this.isActor) modeText = '🚀 高速采样采集';
            document.getElementById('ai-exam').innerText = modeText;
            document.getElementById('ai-exam').style.color = this.isExamMode ? 'red' : (this.isActor ? '#2980b9' : '#d35400');
            document.getElementById('ai-loss').innerText = this.currentLoss.toFixed(4);
            document.getElementById('ai-mem').innerText = this.isActor ? "分布式直传云端" : `${Math.min(this.memory.length, this.maxMemory)}`;
            document.getElementById('ai-fly-mem').innerText = this.isActor ? "-" : `${Math.min(this.flyMemory.length, this.maxFlyMemory)}`;
            
            if (this.isTraining && this.trainingStartTime > 0) {
                let elapsed = Math.floor((Date.now() - this.trainingStartTime) / 1000);
                let m = Math.floor(elapsed / 60);
                let s = elapsed % 60;
                document.getElementById('ai-time').innerHTML = m > 0 ? `${m}分 ${s}秒` : `${s}秒`;
            }
        }
    }
}

// 防重入：只在真正初始化的时候生效
if (!window.aiInstalled) {
    let script = document.createElement('script');
    script.src = '/static/lib/tf.min.js';
    script.onload = () => {
        let checkRunner = setInterval(() => {
            if (window.Runner && window.Runner.instance_) {
                clearInterval(checkRunner);
                window.aiInstalled = true;
                window.ai = new TRexAI(window.Runner.instance_);
            }
        }, 500);
    };
    document.head.appendChild(script);
}
