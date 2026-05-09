class SymbolicAI {
    constructor() {
        this.runner = null;
        this.isActivated = false;
        
        // 规则阈值设置（由专家/程序员定义）
        // 减小反应阈值，让起跳时机更晚一些（更接近仙人掌再跳，避免心悬）
        this.REACTION_DISTANCE_THRESHOLD = 60;
        this.RECOVERY_DISTANCE_THRESHOLD = 50;
        
        this.currentRule = "无"; // 当前激活的规则名称
        
        this.initUI();
    }

    init(runner) {
        this.runner = runner;
        const originalUpdate = window.Runner.prototype.update;
        const originalOnKeyDown = window.Runner.prototype.onKeyDown;
        const sym = this;
        
        // 屏蔽键盘按键输入（包括空格）
        window.Runner.prototype.onKeyDown = function(e) {
            // 如果游戏已经结束，允许按空格或上箭头重新开始
            if (this.crashed && (e.keyCode === 32 || e.keyCode === 38)) {
                originalOnKeyDown.call(this, e);
                return;
            }
            // 如果允许手玩，放行
            if (window.isManualPlayEnabled === true && (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40)) {
                originalOnKeyDown.call(this, e);
                return;
            }
            // 阻止所有控制按键（空格 32，上箭头 38，下箭头 40）
            if (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40) {
                e.preventDefault();
                
                // 弹出提示
                let alertBox = document.getElementById('manualPlayAlert');
                if (!alertBox) {
                    alertBox = document.createElement('div');
                    alertBox.id = 'manualPlayAlert';
                    alertBox.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:#e74c3c; color:white; padding:10px 20px; border-radius:5px; z-index:9999; opacity:1; transition:opacity 0.3s; font-weight:bold; box-shadow:0 4px 6px rgba(0,0,0,0.2); pointer-events:none; font-size:14px;';
                    alertBox.innerText = '教师已关闭手玩模式';
                    document.body.appendChild(alertBox);
                }
                alertBox.style.opacity = '1';
                if (window.manualPlayAlertTimeout) clearTimeout(window.manualPlayAlertTimeout);
                window.manualPlayAlertTimeout = setTimeout(() => { alertBox.style.opacity = '0'; }, 2000);
                
                return;
            }
            originalOnKeyDown.call(this, e);
        };

        const originalOnKeyUp = window.Runner.prototype.onKeyUp;
        window.Runner.prototype.onKeyUp = function(e) {
             // 如果游戏已经结束，允许按空格或上箭头重新开始
             if (this.crashed && (e.keyCode === 32 || e.keyCode === 38)) {
                 if (originalOnKeyUp) originalOnKeyUp.call(this, e);
                 return;
             }
             // 如果允许手玩，放行
             if (window.isManualPlayEnabled === true && (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40)) {
                 if (originalOnKeyUp) originalOnKeyUp.call(this, e);
                 return;
             }
             // 组织松开按键的检测，同上面
             if (e.keyCode === 32 || e.keyCode === 38 || e.keyCode === 40) {
                 e.preventDefault();
                 return;
             }
             if (originalOnKeyUp) originalOnKeyUp.call(this, e);
        };

        window.Runner.prototype.update = function () {
            let wasPlaying = this.playing;
            originalUpdate.call(this);
            sym.calculateAndShowHUD();

            if (this.activated && !this.playingIntro && wasPlaying && sym.isActivated) {
                sym.thinkAndAct();
            } else if (this.activated && !this.playingIntro && wasPlaying && !sym.isActivated) {
                 // 关闭AI但还在跑，什么也不做（由于没触发takeAction所以没有跳跃或下蹲动作）
            }
            if (this.crashed && sym.isActivated) {
                sym.currentRule = "碰撞停机 (1秒后自动重开)";
                sym.updateUI();
                if (wasPlaying) {
                    setTimeout(() => {
                        if (sym.isActivated && this.crashed) {
                            this.restart();
                        }
                    }, 1000);
                }
            } else if (this.crashed && !sym.isActivated) {
                // 如果死亡时没有开启 AI 控制，也让其能依靠开关复活，不响应按键，所以就停在那里
            }
        };
    }


    calculateAndShowHUD() {
        // Disabled for simpler UI
    }

    thinkAndAct() {
        if (!this.runner || !this.runner.horizon || !this.runner.horizon.obstacles.length) return;
        
        let obstacle = this.runner.horizon.obstacles[0];
        const tRex = this.runner.tRex;
        
        // 获取当前障碍物的水平距离 (负数代表小恐龙身位已超过障碍物头部)
        let distance = obstacle.xPos - tRex.xPos - tRex.config.WIDTH;
        
        // 【关键修复】如果第一个障碍物已经被抛在身后，且还有第二个障碍物
        // 游戏引擎在障碍物完全离开左侧屏幕前不会清除它，所以距离可能极度负数，导致无视紧跟其后的新障碍
        if (distance <= -obstacle.width - tRex.config.WIDTH - this.RECOVERY_DISTANCE_THRESHOLD && this.runner.horizon.obstacles.length > 1) {
            obstacle = this.runner.horizon.obstacles[1];
            distance = obstacle.xPos - tRex.xPos - tRex.config.WIDTH;
        }

        // 获取种类高度 (yPos越小，说明在屏幕越高)
        let isBird = obstacle.typeConfig && obstacle.typeConfig.type === 'PTERODACTYL';
        let obsY = obstacle.yPos;
        
        // 计算动态反应阈值 (小恐龙跑得越快，需要越早进行跳跃或下蹲)
        let speedMultiplier = (this.runner.currentSpeed / 6.0);
        let dynamicReactionTTC = this.REACTION_DISTANCE_THRESHOLD; // 取消暗藏的速度补偿

        let action = 0; // 0=RUN, 1=JUMP, 2=DUCK
        this.currentRule = "IF 越位安全 (背向脱离 > 恢复阈值) OR 暂无障碍 THEN 恢复奔跑";

        // ============== 专家系统核心规则库 ==============
        // 只要障碍物的尾部还没有完全超过小恐龙的尾部，就保持对该障碍物的检测
        // 恢复阈值用于定义小恐龙越过障碍物后解除动作(如下蹲恢复)的安全脱离间距
        if (distance > -obstacle.width - tRex.config.WIDTH - this.RECOVERY_DISTANCE_THRESHOLD) { 
            if (isBird) {
                // 取消对翼龙的判断规则（遇到翼龙时，不做任何动作）
            } else {
                // 地面障碍物 (仙人掌)：需要跳跃越过
                if (distance > 0 && distance < dynamicReactionTTC) {
                    action = 1; // 跳跃
                    this.currentRule = "IF 障碍物逼近 (正向距离 < 反应阈值) THEN 跳跃起飞";
                }
            }
        }
        // ============================================

        this.takeAction(action);
        
        // 限制UI刷新频率防止卡顿
        if (this.runner.frameCount % 5 === 0) {
            this.updateUI();
            
            
        }
    }

    takeAction(action) {
        if (!this.isActivated) return; // 如果未开启AI，不执行任何动作
        
        if (action === 1) { // JUMP
            if (this.runner.tRex.ducking) {
                this.runner.tRex.setDuck(false);
            }
            if (!this.runner.tRex.jumping) {
                this.runner.tRex.startJump(this.runner.currentSpeed);
            }
        } else if (action === 2) { // DUCK
            if (this.runner.tRex.jumping) {
                this.runner.tRex.setSpeedDrop();
            } else if (!this.runner.tRex.ducking) {
                this.runner.tRex.setDuck(true);
            }
        } else { // IDLE / RUN
            if (this.runner.tRex.ducking) {
                this.runner.tRex.setDuck(false);
            }
        }
    }

    initUI() {
        const panel = document.createElement('div');
        panel.style.position = 'absolute';
        panel.style.top = '340px';
        panel.style.left = '50%';
        panel.style.transform = 'translateX(-50%)';
        panel.style.width = '540px';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column'; // Changed to column
        panel.style.background = 'rgba(255,255,255,0.95)';
        panel.style.padding = '15px 25px';
        panel.style.border = '2px solid #bdc3c7';
        panel.style.borderRadius = '8px';
        panel.style.fontFamily = 'monospace';
        panel.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
        panel.style.zIndex = '9999';
        
        // Add toggle switch CSS
        const style = document.createElement('style');
        style.innerHTML = `
            .switch { position: relative; display: inline-block; width: 44px; height: 24px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
            .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .slider { background-color: #2ecc71; }
            input:checked + .slider:before { transform: translateX(20px); }
        `;
        document.head.appendChild(style);

        panel.innerHTML = `
            
            <div style="display: flex; flex-direction: column;">
                <div style="font-size:14px;">
                    <div style="font-weight:bold; margin-bottom:8px; text-align: center;">小恐龙躲避仙人掌规则</div>
                    <div style="background:#ecf0f1; padding: 12px; border-radius: 5px;">
                        <div id="sym-rule-1" class="rule-inactive" style="margin-bottom: 5px;">IF 距离仙人掌<strong>较近</strong> THEN <strong>跳跃</strong></div>
                    </div>
                </div>
                
                <div style="display: flex; flex-direction: row; justify-content: center; align-items: center; border-top: 1px solid #ddd; padding-top: 15px; margin-top: 15px;">
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center;">
                        <div style="font-weight: bold; color: #555; text-align: center; margin-bottom: 5px; font-size: 13px;">AI控制</div>
                        <label class="switch" title="开启/关闭机器代打">
                            <input type="checkbox" id="toggle-sym">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        


        document.getElementById('toggle-sym').addEventListener('change', (e) => {
            e.target.blur(); // 失去焦点，防止随后按下空格键时误触发开关
            const btnToggle = document.getElementById('btn-sym-toggle');
            const iconPlay = document.getElementById('sym-icon-play');
            const iconPause = document.getElementById('sym-icon-pause');


            this.isActivated = e.target.checked;
            if(this.isActivated) {
                if(btnToggle) {
                    btnToggle.style.color = '#e74c3c';
                    btnToggle.style.borderColor = '#e74c3c';
                    btnToggle.setAttribute('data-tooltip', '关闭 AI控制');
                    if(iconPlay) iconPlay.style.display = 'none';
                    if(iconPause) iconPause.style.display = 'block';
                }
                
                // 让游戏自动开始并执行跳跃（因为手动按键已被屏蔽）
                let runner = window.Runner.instance_;
                if(runner) {
                    if (runner.crashed) {
                        runner.restart();
                    } else if (!runner.playing) {
                         runner.loadSounds();
                         runner.playing = true;
                         runner.update();
                         if (runner.tRex && !runner.tRex.jumping && !runner.tRex.ducking) {
                             runner.playSound(runner.soundFx.BUTTON_PRESS);
                             runner.tRex.startJump(runner.currentSpeed);
                         }
                    }
                }
                
            } else {
                this.currentRule = "无 (关闭AI不影响奔跑)";
                this.updateUI();
            }
        });
    }
    
    updateUI() {
        document.getElementById('sym-rule-1').className = this.currentRule.includes('跳跃') ? 'rule-active' : 'rule-inactive';
        document.getElementById('sym-rule-0').className = this.currentRule.includes('奔跑') ? 'rule-active' : 'rule-inactive';
    }
}

// 立即挂载符号AI，消除视觉延迟
window.symAI = new SymbolicAI();
let checkInterval = setInterval(() => {
    if (window.Runner && window.Runner.instance_) {
        clearInterval(checkInterval);
        window.symAI.init(window.Runner.instance_);
        console.log("符号AI逻辑注入完毕"); window.focus();
    }
}, 50);
