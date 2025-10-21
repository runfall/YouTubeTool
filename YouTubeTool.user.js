// ==UserScript==
// @name         YouTubeTool
// @version      0.8.9
// @description  在YouTube上按住右箭头键时视频加速到可调节倍速，避免与快进功能冲突。长按5秒可切换持续加速模式。加速状态下单击上下键切换倍速。双击右键退出持续加速模式。长按右键时单击左键快速开启持续加速模式。新增长按自定义功能键时左右键快进快退时间加倍功能。离开视频播放界面时自动重置所有状态。
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

const defaultConfig = {
    defaultSpeedMultiplier: 1.5,
    keyPressDelay: 200,
    longPressDuration: 5000,
    availableSpeeds: [2.5, 2.0, 1.75, 1.5, 1.25],
    controlOpacity: 0.6,
    hoverAreaMultiplier: 1.5,
    doubleClickTimeout: 200,
    seekTime: 5,
    longSeekTime: 10,
    persistentModeHoldSpeed: 3.0,
    persistentModeLeftHoldSpeed: 1.0,
    indicatorFadeDelay: 5000,
    indicatorFadeOpacity: 0.1,
    longSeekKey: 'Shift',
    settingsPanelKey: 's',
    enableAudioFeedback: false,
    showTutorial: true,
    autoRestoreState: true,
    tempSpeedStep: 0.25,
    indicatorPosition: 'center',
    indicatorVerticalPosition: 20
};

(function() {
    'use strict';

    // 加载用户配置
    let config = { ...defaultConfig };
    try {
        const savedConfig = GM_getValue('ytSpeedControlConfig');
        if (savedConfig) config = { ...defaultConfig, ...savedConfig };
    } catch (e) {
        console.log('使用默认配置');
    }

    // 状态变量
    let normalSpeed = 1.0, isSpeedUp = false, isPersistentMode = false, isActive = false;
    let isLongPressing = false, isRightKeyDown = false, isLeftKeyUsedForQuickActivation = false;
    let currentSpeedMultiplier = config.defaultSpeedMultiplier, originalPersistentSpeed = config.defaultSpeedMultiplier;
    let isLeftKeyHoldActive = false, isLongSeekKeyPressed = false, isLongSeekModeLocked = false;
    let isRecordingKey = false, tempLongSeekKey = config.longSeekKey, isSettingsKeyRecording = false;
    let isAdjustingTempSpeed = false, tempSpeedAdjustDirection = null, tempSpeedAdjustInterval = null;

    // 时间变量
    let pressStartTime = 0, leftKeyPressStartTime = 0, lastRightKeyUpTime = 0;
    let lastSpeedKeyPressTime = 0, lastLongSeekKeyUpTime = 0;

    // DOM元素引用
    let speedIndicator = null, speedSelection = null, hoverArea = null;
    let keyConfigButton = null, settingsButton = null, settingsPanel = null, settingsOverlay = null;
    let settingsKeyButton = null, settingsPanelKeyButton = null;

    // 定时器变量
    let speedTimeout = null, longPressTimeout = null, hoverTimeout = null, doubleClickTimeoutId = null;
    let leftKeyTimeoutId = null, indicatorFadeTimeoutId = null, recordingTimeoutId = null;
    let longSeekLockTimeoutId = null, settingsRecordingTimeoutId = null;

    // 监听器变量
    let videoEndListener = null, videoChangeObserver = null, keyRecordListener = null;
    let clickOutsideListener = null, settingsKeyRecordListener = null;
    let miniPlayerObserver = null, playerResizeObserver = null, playerStateObserver = null;
    
    // 新增防抖变量
    let checkPlayerStateTimeout = null, playerCheckInterval = null;

    // 冲突检测配置
    const CONFLICT_KEYS = {
        YOUTUBE: ['k', 'K', 'm', 'M', 'f', 'F', 't', 'T', 'c', 'C', 'j', 'J', 'l', 'L', ' ', 'Home', 'End', '0', '4', '5', '6', '7', '8', '9'],
        SYSTEM: ['Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
        INTERNAL: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    };

    const ALL_CONFLICT_KEYS = [...new Set([...CONFLICT_KEYS.YOUTUBE, ...CONFLICT_KEYS.SYSTEM, ...CONFLICT_KEYS.INTERNAL])];

    function isKeyConflicting(key, keyType) {
        if (ALL_CONFLICT_KEYS.includes(key)) return `快捷键冲突`;
        if (keyType === 'longSeekKey' && key === config.settingsPanelKey) return `快捷键冲突`;
        if (keyType === 'settingsPanelKey' && key === config.longSeekKey) return `快捷键冲突`;
        return null;
    }

    function showConflictMessage(message) {
        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.cssText = `position: fixed; top: 100px; left: 50%; transform: translateX(-50%); background: #cc0000; color: white; padding: 12px 24px; border-radius: 6px; z-index: 2147483647; font-size: 14px; font-family: 'YouTube Sans', 'Roboto', sans-serif; font-weight: 500; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); max-width: 400px; text-align: center;`;
        document.body.appendChild(msg);
        setTimeout(() => msg.parentNode && msg.parentNode.removeChild(msg), 3000);
    }

    function showTemporaryMessage(message) {
        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.cssText = `position: fixed; top: 60px; left: 50%; transform: translateX(-50%); background: #0f0f0f; color: white; padding: 12px 24px; border-radius: 6px; z-index: 2147483647; font-size: 14px; font-family: 'YouTube Sans', 'Roboto', sans-serif; font-weight: 500; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);`;
        document.body.appendChild(msg);
        setTimeout(() => msg.parentNode && msg.parentNode.removeChild(msg), 2000);
    }

    // 改进的视频页面检测 - 增强版本
    function isVideoPage() {
        const url = window.location.href;
        const pathname = window.location.pathname;
        
        // 明确的视频播放页面
        if (url.includes('/watch?v=') ||
            url.includes('/embed/') ||
            url.includes('/live/') ||
            (pathname === '/watch' && url.includes('v='))) {
            return true;
        }
        
        // 明确的非视频页面
        if (pathname === '/' || // 首页
            pathname.startsWith('/feed/') || // 动态feed
            pathname.startsWith('/results') || // 搜索结果
            pathname.startsWith('/channel/') || // 频道页
            pathname.startsWith('/c/') || // 自定义频道页
            pathname.startsWith('/user/') || // 用户页
            pathname.startsWith('/playlist') || // 播放列表
            pathname.startsWith('/subscriptions') || // 订阅
            pathname.startsWith('/library') || // 媒体库
            pathname.startsWith('/history') || // 历史记录
            pathname.startsWith('/trending') || // 趋势
            pathname.startsWith('/gaming') || // 游戏
            pathname.startsWith('/premium') || // Premium
            pathname.startsWith('/account') // 账户
        ) {
            return false;
        }
        
        // 其他情况，检查是否有视频元素存在
        return !!getVideoElement();
    }

    // 改进的视频元素获取 - 增强错误处理
    function getVideoElement() {
        try {
            const video = document.querySelector('video.html5-main-video, video.video-stream');
            if (!video) {
                console.warn('未找到视频元素，脚本功能受限');
                return null;
            }
            return video;
        } catch (error) {
            console.error('获取视频元素时出错:', error);
            return null;
        }
    }

    // 改进的播放器焦点检测
    function isFocusOnVideoPlayer() {
        try {
            const activeElement = document.activeElement;
            const playerContainer = document.querySelector('#movie_player, .html5-video-player');

            // 排除输入框和可编辑元素
            if (activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable) {
                return false;
            }

            // 检查是否在播放器内或全屏状态下
            return (playerContainer && playerContainer.contains(activeElement)) ||
                   document.fullscreenElement ||
                   (isVideoPage() && !activeElement.closest('ytd-searchbox, ytd-comment-simplebox'));
        } catch (error) {
            console.error('检测播放器焦点时出错:', error);
            return false;
        }
    }

    // 定时器管理 - 增强版本
    function clearAllTimeouts() {
        [speedTimeout, longPressTimeout, hoverTimeout, doubleClickTimeoutId, leftKeyTimeoutId, indicatorFadeTimeoutId, recordingTimeoutId, longSeekLockTimeoutId, settingsRecordingTimeoutId]
            .forEach(timeout => timeout && clearTimeout(timeout));
        speedTimeout = longPressTimeout = hoverTimeout = doubleClickTimeoutId = leftKeyTimeoutId = indicatorFadeTimeoutId = recordingTimeoutId = longSeekLockTimeoutId = settingsRecordingTimeoutId = null;
    }

    function scheduleIndicatorFade() {
        clearTimeout(indicatorFadeTimeoutId);
        indicatorFadeTimeoutId = setTimeout(() => {
            if (speedIndicator && speedIndicator.style.opacity === '1') {
                speedIndicator.style.opacity = config.indicatorFadeOpacity;
            }
        }, config.indicatorFadeDelay);
    }

    function resetIndicatorFade() {
        clearTimeout(indicatorFadeTimeoutId);
        if (speedIndicator) speedIndicator.style.opacity = '1';
        scheduleIndicatorFade();
    }

    // UI元素管理 - 修复重复创建问题
    function createSpeedIndicator() {
        // 检查是否已存在
        const existingIndicator = document.getElementById('yt-speed-indicator');
        if (existingIndicator && document.body.contains(existingIndicator)) {
            return existingIndicator;
        }
        
        // 清理可能存在的旧元素
        if (speedIndicator && speedIndicator.parentNode) {
            speedIndicator.parentNode.removeChild(speedIndicator);
        }
        
        const indicator = document.createElement('div');
        indicator.id = 'yt-speed-indicator';
        
        // 根据配置设置位置样式
        let positionStyle = '';
        if (config.indicatorPosition === 'left') {
            positionStyle = `left: 20px; right: auto; transform: none;`;
        } else if (config.indicatorPosition === 'right') {
            positionStyle = `right: 20px; left: auto; transform: none;`;
        } else { // center (默认)
            positionStyle = `left: 50%; transform: translateX(-50%);`;
        }
        
        // 使用配置的垂直位置
        const verticalPosition = Math.max(10, Math.min(window.innerHeight - 50, config.indicatorVerticalPosition));
        
        indicator.style.cssText = `position: fixed; top: ${verticalPosition}px; ${positionStyle} padding: 8px 16px; border-radius: 8px; z-index: 2147483647; font-size: 14px; font-weight: 500; font-family: system-ui, sans-serif; display: none; opacity: 0; transition: all 0.2s ease; background: rgba(255, 255, 255, 0.95); color: #000; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); backdrop-filter: blur(8px); border: 1px solid rgba(0, 0, 0, 0.1);`;
        document.body.appendChild(indicator);
        return indicator;
    }

    function showSpeedIndicator() {
        if (!isActive) return;
        if (!speedIndicator) speedIndicator = createSpeedIndicator();
        const hasLongSeekMode = isLongSeekModeLocked || isLongSeekKeyPressed;
        const hasSpeedMode = isSpeedUp || isPersistentMode;
        let indicatorText = '';
        if (hasSpeedMode && hasLongSeekMode) indicatorText = isPersistentMode ? `${currentSpeedMultiplier}x 🔒 ⚡` : `${currentSpeedMultiplier}x ⚡`;
        else if (hasSpeedMode) indicatorText = isPersistentMode ? `${currentSpeedMultiplier}x 🔒` : `${currentSpeedMultiplier}x`;
        else if (hasLongSeekMode) indicatorText = '⚡';
        if (!indicatorText) { hideSpeedIndicator(); return; }
        speedIndicator.textContent = indicatorText;
        speedIndicator.style.display = 'block';
        speedIndicator.style.opacity = '1';
        
        // 根据配置设置位置变换
        if (config.indicatorPosition === 'center') {
            speedIndicator.style.transform = 'translateX(-50%) translateY(0)';
        } else {
            speedIndicator.style.transform = 'translateY(0)';
        }
        
        if (isLongSeekModeLocked || isPersistentMode) resetIndicatorFade(); else scheduleIndicatorFade();
    }

    function hideSpeedIndicator() {
        if (isLongSeekModeLocked || isPersistentMode) { resetIndicatorFade(); return; }
        if (speedIndicator) {
            speedIndicator.style.opacity = '0';
            // 根据配置设置隐藏时的变换
            if (config.indicatorPosition === 'center') {
                speedIndicator.style.transform = 'translateX(-50%) translateY(-10px)';
            } else {
                speedIndicator.style.transform = 'translateY(-10px)';
            }
            setTimeout(() => speedIndicator && !isLongSeekModeLocked && !isPersistentMode && (speedIndicator.style.display = 'none'), 200);
        }
        clearTimeout(indicatorFadeTimeoutId);
    }

    function createSpeedSelection() {
        // 检查是否已存在
        const existingSelection = document.getElementById('yt-speed-selection');
        if (existingSelection && document.body.contains(existingSelection)) {
            return existingSelection;
        }
        
        // 清理可能存在的旧元素
        if (speedSelection && speedSelection.parentNode) {
            speedSelection.parentNode.removeChild(speedSelection);
        }
        
        const container = document.createElement('div');
        container.id = 'yt-speed-selection';
        container.style.cssText = `position: absolute; top: 50%; right: 10px; transform: translateY(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 9999; background: rgba(28, 28, 28, ${config.controlOpacity}); padding: 10px 8px; border-radius: 8px; backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.1); transition: opacity 0.3s ease; opacity: 0; pointer-events: none;`;
        const buttonStyle = `color: white; border: none; border-radius: 4px; padding: 6px 10px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s ease; min-width: 40px;`;
        
        // 确保availableSpeeds不为空
        if (!config.availableSpeeds || config.availableSpeeds.length === 0) {
            config.availableSpeeds = [...defaultConfig.availableSpeeds];
        }
        
        config.availableSpeeds.forEach(speed => {
            const button = document.createElement('button');
            button.textContent = `${speed}x`;
            button.dataset.speed = speed;
            const isSelected = speed === currentSpeedMultiplier;
            button.style.cssText = buttonStyle + `background: ${isSelected ? 'rgba(255, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.1)'};`;
            button.addEventListener('mouseenter', () => button.style.background = isSelected ? 'rgba(255, 0, 0, 0.9)' : 'rgba(255, 255, 255, 0.2)');
            button.addEventListener('mouseleave', () => button.style.background = isSelected ? 'rgba(255, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.1)');
            button.addEventListener('click', (e) => { e.stopPropagation(); setSpeedMultiplier(speed, true); });
            container.appendChild(button);
        });
        const separator = document.createElement('div');
        separator.style.cssText = 'height: 1px; background: rgba(255, 255, 255, 0.2); margin: 4px 0;';
        container.appendChild(separator);
        keyConfigButton = document.createElement('button');
        keyConfigButton.id = 'yt-key-config-button';
        updateKeyConfigButton();
        keyConfigButton.style.cssText = buttonStyle + `background: rgba(255, 255, 255, 0.1); font-size: 11px; margin-top: 4px;`;
        keyConfigButton.addEventListener('mouseenter', () => !isRecordingKey && (keyConfigButton.style.background = 'rgba(255, 255, 255, 0.2)'));
        keyConfigButton.addEventListener('mouseleave', () => !isRecordingKey && (keyConfigButton.style.background = 'rgba(255, 255, 255, 0.1)'));
        keyConfigButton.addEventListener('click', (e) => { e.stopPropagation(); !isRecordingKey && startKeyRecording(); });
        container.appendChild(keyConfigButton);
        settingsButton = document.createElement('button');
        settingsButton.id = 'yt-settings-button';
        settingsButton.textContent = '设置';
        settingsButton.style.cssText = buttonStyle + `background: rgba(255, 255, 255, 0.1); font-size: 11px; margin-top: 4px;`;
        settingsButton.addEventListener('mouseenter', () => settingsButton.style.background = 'rgba(255, 255, 255, 0.2)');
        settingsButton.addEventListener('mouseleave', () => settingsButton.style.background = 'rgba(255, 255, 255, 0.1)');
        settingsButton.addEventListener('click', (e) => { e.stopPropagation(); showSettingsPanel(); });
        container.appendChild(settingsButton);
        return container;
    }

    function updateKeyConfigButton() {
        if (!keyConfigButton) return;
        keyConfigButton.textContent = isRecordingKey ? '按下:' : config.longSeekKey;
        keyConfigButton.style.background = isRecordingKey ? 'rgba(255, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.1)';
        updateSettingsKeyButton();
    }

    function updateSpeedSelection() {
        if (!speedSelection) return;
        speedSelection.querySelectorAll('button[data-speed]').forEach(button => {
            const speed = parseFloat(button.dataset.speed);
            const isSelected = speed === currentSpeedMultiplier;
            button.style.background = isSelected ? 'rgba(255, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.1)';
        });
    }

    // 检测是否处于小窗模式
    function isMiniPlayerMode() {
        try {
            const playerContainer = document.querySelector('#movie_player, .html5-video-player');
            if (!playerContainer) return false;
            
            // 检查是否有小窗模式相关的类名
            if (playerContainer.classList.contains('ytp-miniplayer') || 
                playerContainer.classList.contains('miniplayer')) {
                return true;
            }
            
            // 检查播放器大小 - 小窗模式通常较小
            const rect = playerContainer.getBoundingClientRect();
            if (rect.width < 400 || rect.height < 250) {
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('检测小窗模式时出错:', error);
            return false;
        }
    }

    // 悬停检测
    function updateHoverAreaSize() {
        if (!hoverArea || !speedSelection) return;
        const controlRect = speedSelection.getBoundingClientRect();
        hoverArea.style.width = `${controlRect.width * config.hoverAreaMultiplier}px`;
        hoverArea.style.height = `${controlRect.height * config.hoverAreaMultiplier}px`;
        hoverArea.style.top = `50%`;
        hoverArea.style.transform = `translateY(-50%)`;
    }

    function setupHoverDetection() {
        const playerContainer = document.querySelector('#movie_player, .html5-video-player');
        if (!playerContainer || !speedSelection) return;
        
        // 清理可能存在的旧悬停区域
        if (hoverArea && hoverArea.parentNode) {
            hoverArea.parentNode.removeChild(hoverArea);
        }
        
        hoverArea = document.createElement('div');
        hoverArea.style.cssText = `position: absolute; right: 0; z-index: 9998; cursor: default;`;
        playerContainer.appendChild(hoverArea);
        updateHoverAreaSize();
        let isHovering = false;
        const handleMouseEnter = () => {
            clearTimeout(hoverTimeout);
            isHovering = true;
            // 小窗模式下不显示速度选择器
            if (!isMiniPlayerMode()) {
                speedSelection.style.opacity = config.controlOpacity;
                speedSelection.style.pointerEvents = 'auto';
            }
        };
        const handleMouseLeave = () => {
            isHovering = false;
            hoverTimeout = setTimeout(() => {
                if (!isHovering) {
                    speedSelection.style.opacity = '0';
                    speedSelection.style.pointerEvents = 'none';
                }
            }, 300);
        };
        hoverArea.addEventListener('mouseenter', handleMouseEnter);
        hoverArea.addEventListener('mouseleave', handleMouseLeave);
        speedSelection.addEventListener('mouseenter', handleMouseEnter);
        speedSelection.addEventListener('mouseleave', handleMouseLeave);
        playerContainer.addEventListener('mouseleave', () => {
            isHovering = false;
            speedSelection.style.opacity = '0';
            speedSelection.style.pointerEvents = 'none';
        });
        
        // 清理旧的ResizeObserver
        if (playerResizeObserver) {
            playerResizeObserver.disconnect();
        }
        
        playerResizeObserver = new ResizeObserver(updateHoverAreaSize);
        playerResizeObserver.observe(speedSelection);
    }

    function addSpeedSelectionToPlayer() {
        const playerContainer = document.querySelector('#movie_player, .html5-video-player');
        if (playerContainer) {
            // 检查是否已存在
            const existingSelection = playerContainer.querySelector('#yt-speed-selection');
            if (existingSelection) {
                speedSelection = existingSelection;
                setupHoverDetection();
                return;
            }
            
            // 创建新的速度选择器
            speedSelection = createSpeedSelection();
            playerContainer.appendChild(speedSelection);
            setupHoverDetection();
            
            // 清理旧的ResizeObserver
            if (playerStateObserver) {
                playerStateObserver.disconnect();
            }
            
            // 监听播放器大小变化，小窗模式下隐藏速度选择器
            playerStateObserver = new ResizeObserver(() => {
                if (speedSelection && playerContainer) {
                    const playerRect = playerContainer.getBoundingClientRect();
                    const isMiniPlayer = isMiniPlayerMode();
                    
                    // 小窗模式或播放器太小则隐藏，否则显示
                    if (isMiniPlayer || playerRect.height <= 200) {
                        speedSelection.style.display = 'none';
                        if (hoverArea) hoverArea.style.display = 'none';
                    } else {
                        speedSelection.style.display = 'flex';
                        if (hoverArea) hoverArea.style.display = 'block';
                    }
                    
                    updateHoverAreaSize();
                }
            });
            playerStateObserver.observe(playerContainer);
        }
    }

    // 速度控制核心函数 - 增强错误处理
    function setSpeedMultiplier(speed, updatePersistentSpeed = false) {
        try {
            currentSpeedMultiplier = speed;
            updateSpeedSelection();
            if (updatePersistentSpeed && isPersistentMode) originalPersistentSpeed = currentSpeedMultiplier;
            if (isSpeedUp || isPersistentMode) {
                const video = getVideoElement();
                if (video) video.playbackRate = currentSpeedMultiplier;
            }
            showSpeedIndicator();
        } catch (error) {
            console.error('设置速度倍数时出错:', error);
        }
    }

    function changeSpeedMultiplier(direction) {
        if (!isSpeedUp && !isPersistentMode) return;
        
        // 确保availableSpeeds不为空
        if (!config.availableSpeeds || config.availableSpeeds.length === 0) {
            config.availableSpeeds = [...defaultConfig.availableSpeeds];
        }
        
        const currentIndex = config.availableSpeeds.indexOf(currentSpeedMultiplier);
        let newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (newIndex >= 0 && newIndex < config.availableSpeeds.length) setSpeedMultiplier(config.availableSpeeds[newIndex], true);
    }

    function adjustTempSpeed(direction) {
        if (!isPersistentMode) return;
        let targetSpeed, configKey;
        if (isLongPressing) { targetSpeed = config.persistentModeHoldSpeed; configKey = 'persistentModeHoldSpeed'; }
        else if (isLeftKeyHoldActive) { targetSpeed = config.persistentModeLeftHoldSpeed; configKey = 'persistentModeLeftHoldSpeed'; }
        else return;
        const step = config.tempSpeedStep;
        let newSpeed = direction === 'up' ? targetSpeed + step : targetSpeed - step;
        newSpeed = Math.max(0.25, Math.min(8, newSpeed));
        newSpeed = Math.round(newSpeed * 100) / 100;
        if (isLongPressing) { config.persistentModeHoldSpeed = newSpeed; currentSpeedMultiplier = newSpeed; }
        else if (isLeftKeyHoldActive) { config.persistentModeLeftHoldSpeed = newSpeed; currentSpeedMultiplier = newSpeed; }
        try { 
            GM_setValue('ytSpeedControlConfig', config); 
        } catch (e) { 
            console.error('保存设置失败:', e);
            showTemporaryMessage('保存设置失败，请检查控制台');
        }
        updateSettingsInput(configKey, newSpeed);
        updateVideoSpeed();
    }

    function startContinuousTempSpeedAdjust(direction) {
        if (isAdjustingTempSpeed) return;
        isAdjustingTempSpeed = true;
        tempSpeedAdjustDirection = direction;
        adjustTempSpeed(direction);
        let delay = 300;
        const minDelay = 100;
        tempSpeedAdjustInterval = setInterval(() => {
            adjustTempSpeed(direction);
            if (delay > minDelay) {
                delay = Math.max(minDelay, delay - 50);
                clearInterval(tempSpeedAdjustInterval);
                tempSpeedAdjustInterval = setInterval(() => adjustTempSpeed(direction), delay);
            }
        }, delay);
    }

    function stopContinuousTempSpeedAdjust() {
        if (!isAdjustingTempSpeed) return;
        isAdjustingTempSpeed = false;
        tempSpeedAdjustDirection = null;
        if (tempSpeedAdjustInterval) {
            clearInterval(tempSpeedAdjustInterval);
            tempSpeedAdjustInterval = null;
        }
    }

    function accelerateVideo() {
        if (!isActive) return;
        try {
            const video = getVideoElement();
            if (video) {
                if (!isPersistentMode) normalSpeed = video.playbackRate;
                video.playbackRate = currentSpeedMultiplier;
                isSpeedUp = true;
                showSpeedIndicator();
            }
        } catch (error) {
            console.error('加速视频时出错:', error);
        }
    }

    function restoreNormalSpeed() {
        if (!isPersistentMode && isSpeedUp) {
            try {
                const video = getVideoElement();
                if (video) {
                    video.playbackRate = normalSpeed;
                    isSpeedUp = false;
                    if (isLongSeekModeLocked || isLongSeekKeyPressed) showSpeedIndicator(); else hideSpeedIndicator();
                }
            } catch (error) {
                console.error('恢复正常速度时出错:', error);
            }
        }
    }

    function togglePersistentMode() {
        if (!isActive) return;
        try {
            const video = getVideoElement();
            if (!isPersistentMode) {
                if (video) {
                    normalSpeed = video.playbackRate;
                    video.playbackRate = currentSpeedMultiplier;
                    isSpeedUp = true;
                }
                isPersistentMode = true;
                originalPersistentSpeed = currentSpeedMultiplier;
                showSpeedIndicator();
                setupVideoEndListener();
            } else {
                if (video) video.playbackRate = normalSpeed;
                isPersistentMode = false;
                isSpeedUp = false;
                if (isLongSeekModeLocked || isLongSeekKeyPressed) showSpeedIndicator(); else hideSpeedIndicator();
            }
        } catch (error) {
            console.error('切换持续加速模式时出错:', error);
        }
    }

    // 持续加速模式长按功能
    function applyPersistentModeHoldSpeed() {
        if (!isPersistentMode) return;
        originalPersistentSpeed = currentSpeedMultiplier;
        currentSpeedMultiplier = config.persistentModeHoldSpeed;
        updateVideoSpeed();
    }

    function restorePersistentModeOriginalSpeed() {
        if (!isPersistentMode) return;
        currentSpeedMultiplier = originalPersistentSpeed;
        updateVideoSpeed();
    }

    function applyPersistentModeLeftHoldSpeed() {
        if (!isPersistentMode || isLeftKeyHoldActive) return;
        originalPersistentSpeed = currentSpeedMultiplier;
        currentSpeedMultiplier = config.persistentModeLeftHoldSpeed;
        isLeftKeyHoldActive = true;
        updateVideoSpeed();
    }

    function restorePersistentModeFromLeftHold() {
        if (!isPersistentMode || !isLeftKeyHoldActive) return;
        currentSpeedMultiplier = originalPersistentSpeed;
        isLeftKeyHoldActive = false;
        updateVideoSpeed();
    }

    function updateVideoSpeed() {
        try {
            const video = getVideoElement();
            if (video) video.playbackRate = currentSpeedMultiplier;
            updateSpeedSelection();
            showSpeedIndicator();
            resetIndicatorFade();
        } catch (error) {
            console.error('更新视频速度时出错:', error);
        }
    }

    // 长快进功能
    function getSeekTime() {
        return (isLongSeekModeLocked || isLongSeekKeyPressed) ? config.longSeekTime : config.seekTime;
    }

    function handleLongSeekKeyDown(event) {
        if (event.key === config.longSeekKey && !event.repeat && !isRecordingKey) {
            isLongSeekKeyPressed = true;
            showSpeedIndicator();
        }
    }

    function handleLongSeekKeyUp(event) {
        if (event.key === config.longSeekKey && !isRecordingKey) {
            const currentTime = Date.now();
            if (lastLongSeekKeyUpTime && currentTime - lastLongSeekKeyUpTime < config.doubleClickTimeout) {
                isLongSeekModeLocked = !isLongSeekModeLocked;
                lastLongSeekKeyUpTime = 0;
                if (isLongSeekModeLocked) {
                    clearTimeout(longSeekLockTimeoutId);
                    longSeekLockTimeoutId = setTimeout(() => {
                        isLongSeekModeLocked = false;
                        showSpeedIndicator();
                    }, 5 * 60 * 1000);
                }
            } else lastLongSeekKeyUpTime = currentTime;
            isLongSeekKeyPressed = false;
            showSpeedIndicator();
        }
    }

    // 键盘事件处理
    function handleSpeedKeyPress(event) {
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && (isSpeedUp || isPersistentMode)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (event.repeat) return true;
            const currentTime = Date.now();
            if (currentTime - lastSpeedKeyPressTime < config.doubleClickTimeout) return true;
            lastSpeedKeyPressTime = currentTime;
            if (isPersistentMode && (isLongPressing || isLeftKeyHoldActive)) adjustTempSpeed(event.key === 'ArrowUp' ? 'up' : 'down');
            else changeSpeedMultiplier(event.key === 'ArrowUp' ? 'up' : 'down');
            return true;
        }
        return false;
    }

    function handleSettingsPanelKey(event) {
        // 修复bug：在设置按键时，不处理设置面板快捷键
        if (event.key === config.settingsPanelKey && !event.repeat && !isRecordingKey && !isSettingsKeyRecording) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (settingsPanel && settingsPanel.style.display === 'block') hideSettingsPanel(); else showSettingsPanel();
            return true;
        }
        return false;
    }

    function handleKeyDown(event) {
        if (!isActive || !isFocusOnVideoPlayer() || isRecordingKey) return;
        handleLongSeekKeyDown(event);
        if (handleSettingsPanelKey(event)) return;
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && isPersistentMode && (isLongPressing || isLeftKeyHoldActive)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (event.repeat) return;
            startContinuousTempSpeedAdjust(event.key === 'ArrowUp' ? 'up' : 'down');
            return;
        }
        if (handleSpeedKeyPress(event)) return;
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) {
                isRightKeyDown = true;
                pressStartTime = Date.now();
                isLongPressing = false;
                clearAllTimeouts();
                speedTimeout = setTimeout(() => {
                    accelerateVideo();
                    isLongPressing = true;
                    if (isPersistentMode) applyPersistentModeHoldSpeed();
                    longPressTimeout = setTimeout(() => !isPersistentMode && togglePersistentMode(), config.longPressDuration);
                }, config.keyPressDelay);
            }
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) {
                leftKeyPressStartTime = Date.now();
                isLeftKeyUsedForQuickActivation = false;
                clearTimeout(leftKeyTimeoutId);
                if (isPersistentMode) leftKeyTimeoutId = setTimeout(applyPersistentModeLeftHoldSpeed, config.keyPressDelay);
            }
        }
        if (event.key === 'ArrowLeft' && isRightKeyDown && isLongPressing && !isPersistentMode) {
            event.preventDefault();
            event.stopPropagation();
            isLeftKeyUsedForQuickActivation = true;
            clearAllTimeouts();
            togglePersistentMode();
        }
    }

    function handleKeyUp(event) {
        if (!isActive || !isFocusOnVideoPlayer() || isRecordingKey) return;
        handleLongSeekKeyUp(event);
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && isAdjustingTempSpeed) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            stopContinuousTempSpeedAdjust();
            return;
        }
        if (event.key === 'ArrowRight') {
            isRightKeyDown = false;
            const pressDuration = Date.now() - pressStartTime;
            clearAllTimeouts();
            if (isPersistentMode && isLongPressing) restorePersistentModeOriginalSpeed();
            isLongPressing = false;
            const currentTime = Date.now();
            if (currentTime - lastRightKeyUpTime < config.doubleClickTimeout) {
                if (isPersistentMode || !isSpeedUp) togglePersistentMode();
                lastRightKeyUpTime = 0;
            } else {
                lastRightKeyUpTime = currentTime;
                doubleClickTimeoutId = setTimeout(() => {
                    const video = getVideoElement();
                    if (video) {
                        const seekTime = getSeekTime();
                        if (pressDuration < config.doubleClickTimeout) video.currentTime += seekTime;
                        if (!isPersistentMode && isSpeedUp) restoreNormalSpeed();
                    }
                }, config.doubleClickTimeout);
            }
        }
        if (event.key === 'ArrowLeft') {
            const pressDuration = Date.now() - leftKeyPressStartTime;
            clearTimeout(leftKeyTimeoutId);
            if (isPersistentMode && isLeftKeyHoldActive) restorePersistentModeFromLeftHold();
            if (!isLeftKeyUsedForQuickActivation) leftKeyTimeoutId = setTimeout(() => {
                if (pressDuration < config.doubleClickTimeout) {
                    const video = getVideoElement();
                    if (video) video.currentTime -= getSeekTime();
                }
            }, config.doubleClickTimeout);
            isLeftKeyUsedForQuickActivation = false;
        }
    }

    // 事件监听器管理
    let eventListenersAdded = false;
    function addEventListeners() { 
        if (eventListenersAdded) return; 
        document.addEventListener('keydown', handleKeyDown, true); 
        document.addEventListener('keyup', handleKeyUp, true); 
        eventListenersAdded = true; 
    }
    
    function removeEventListeners() { 
        if (!eventListenersAdded) return; 
        document.removeEventListener('keydown', handleKeyDown, true); 
        document.removeEventListener('keyup', handleKeyUp, true); 
        eventListenersAdded = false; 
    }

    // 视频监听器管理 - 完全修复版本
    function setupVideoEndListener() {
        const video = getVideoElement();
        if (!video) return;
        if (videoEndListener) video.removeEventListener('ended', videoEndListener);
        videoEndListener = () => {
            // 视频结束时重置所有状态，包括长快进功能和持续加速模式
            console.log('视频结束，重置所有状态');
            resetAllStatesOnVideoEnd();
        };
        video.addEventListener('ended', videoEndListener);
    }

    // 专门处理视频结束时的状态重置
    function resetAllStatesOnVideoEnd() {
        console.log('重置所有状态 - 视频结束');
        
        // 重置所有状态变量
        isPersistentMode = false;
        isSpeedUp = false;
        isLongSeekKeyPressed = false;
        isLongSeekModeLocked = false;
        isLongPressing = false;
        isRightKeyDown = false;
        isLeftKeyHoldActive = false;
        isAdjustingTempSpeed = false;
        tempSpeedAdjustDirection = null;
        
        // 停止所有定时器
        clearAllTimeouts();
        if (tempSpeedAdjustInterval) {
            clearInterval(tempSpeedAdjustInterval);
            tempSpeedAdjustInterval = null;
        }
        if (longSeekLockTimeoutId) {
            clearTimeout(longSeekLockTimeoutId);
            longSeekLockTimeoutId = null;
        }
        
        // 恢复视频正常速度
        const video = getVideoElement();
        if (video) {
            try {
                video.playbackRate = 1.0;
                console.log('恢复视频正常播放速度');
            } catch (error) {
                console.error('恢复视频速度时出错:', error);
            }
        }
        
        // 重置速度乘数
        currentSpeedMultiplier = config.defaultSpeedMultiplier;
        
        // 更新UI
        updateSpeedSelection();
        hideSpeedIndicator();
        
        console.log('所有状态已重置');
    }

    // 增强的页面状态检测和重置逻辑
    function setupEnhancedPageStateMonitor() {
        if (videoChangeObserver) videoChangeObserver.disconnect();

        let lastUrl = location.href;
        let lastVideoState = isVideoPage();

        videoChangeObserver = new MutationObserver(() => {
            const currentUrl = location.href;
            const currentVideoState = isVideoPage();
            
            // URL发生变化或视频状态发生变化
            if (currentUrl !== lastUrl || currentVideoState !== lastVideoState) {
                lastUrl = currentUrl;
                lastVideoState = currentVideoState;
                
                if (!currentVideoState) {
                    // 离开视频页面，重置所有状态
                    console.log('检测到离开视频页面，重置脚本状态');
                    resetAllStatesOnVideoEnd();
                    deactivateScript();
                } else {
                    // 仍在视频页面，但可能切换了视频
                    console.log('检测到视频页面变化，重置速度状态');
                    resetAllStatesOnVideoEnd();
                    activateScript();
                }
            }
        });

        videoChangeObserver.observe(document, { 
            subtree: true, 
            childList: true,
            attributes: true,
            attributeFilter: ['href', 'src', 'class']
        });

        // 额外监听播放器DOM变化
        const playerObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    const playerContainer = document.querySelector('#movie_player, .html5-video-player');
                    if (playerContainer && (!speedSelection || !playerContainer.contains(speedSelection))) {
                        setTimeout(() => {
                            if (speedSelection && speedSelection.parentNode) {
                                speedSelection.parentNode.removeChild(speedSelection);
                            }
                            speedSelection = null;
                            addSpeedSelectionToPlayer();
                        }, 100);
                    }
                }
            });
        });

        playerObserver.observe(document.body, { childList: true, subtree: true });

        return { urlObserver: videoChangeObserver, playerObserver };
    }

    // 状态管理
    function resetPersistentMode() {
        isPersistentMode = false;
        isSpeedUp = false;
        if (isLongSeekModeLocked || isLongSeekKeyPressed) showSpeedIndicator(); else hideSpeedIndicator();
        currentSpeedMultiplier = config.defaultSpeedMultiplier;
        updateSpeedSelection();
    }

    function resetAllSpeedStates() {
        console.log('重置所有速度状态');
        isPersistentMode = isSpeedUp = isLongSeekKeyPressed = isLongSeekModeLocked = isRecordingKey = isAdjustingTempSpeed = false;
        tempSpeedAdjustDirection = null;
        if (tempSpeedAdjustInterval) { clearInterval(tempSpeedAdjustInterval); tempSpeedAdjustInterval = null; }
        hideSpeedIndicator();
        cleanupKeyRecording();
        clearTimeout(longSeekLockTimeoutId);
        const video = getVideoElement();
        if (video) {
            try {
                video.playbackRate = 1.0;
                console.log('恢复视频正常播放速度');
            } catch (error) {
                console.error('恢复视频速度时出错:', error);
            }
        }
        currentSpeedMultiplier = config.defaultSpeedMultiplier;
        updateSpeedSelection();
    }

    // 功能键配置
    function startKeyRecording() {
        if (isRecordingKey) return;
        isRecordingKey = true;
        tempLongSeekKey = config.longSeekKey;
        updateKeyConfigButton();
        recordingTimeoutId = setTimeout(cancelKeyRecording, 5000);
        keyRecordListener = (e) => handleKeyRecord(e);
        document.addEventListener('keydown', keyRecordListener, true);
        clickOutsideListener = (e) => !speedSelection.contains(e.target) && cancelKeyRecording();
        document.addEventListener('click', clickOutsideListener, true);
        speedSelection.style.pointerEvents = 'auto';
    }

    function handleKeyRecord(event) {
        event.preventDefault();
        event.stopPropagation();
        const key = event.key;
        const conflict = isKeyConflicting(key, 'longSeekKey');
        if (conflict) { showConflictMessage(conflict); cancelKeyRecording(); return; }
        config.longSeekKey = key;
        isRecordingKey = false;
        updateKeyConfigButton();
        cleanupKeyRecording();
    }

    function cancelKeyRecording() {
        isRecordingKey = false;
        config.longSeekKey = tempLongSeekKey;
        updateKeyConfigButton();
        cleanupKeyRecording();
    }

    function cleanupKeyRecording() {
        clearTimeout(recordingTimeoutId);
        recordingTimeoutId = null;
        if (keyRecordListener) { document.removeEventListener('keydown', keyRecordListener, true); keyRecordListener = null; }
        if (clickOutsideListener) { document.removeEventListener('click', clickOutsideListener, true); clickOutsideListener = null; }
        if (speedSelection) speedSelection.style.pointerEvents = 'none';
    }

    // 设置面板函数
    function createSettingsPanel() {
        if (settingsPanel && document.body.contains(settingsPanel)) return settingsPanel;
        if (!settingsOverlay) {
            settingsOverlay = document.createElement('div');
            settingsOverlay.id = 'yt-speed-settings-overlay';
            settingsOverlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 2147483646; display: none; backdrop-filter: blur(2px);`;
            settingsOverlay.addEventListener('click', hideSettingsPanel);
            document.body.appendChild(settingsOverlay);
        }
        
        // 清理可能存在的旧设置面板
        if (settingsPanel && settingsPanel.parentNode) {
            settingsPanel.parentNode.removeChild(settingsPanel);
        }
        
        const panel = document.createElement('div');
        panel.id = 'yt-speed-settings-panel';
        panel.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #ffffff; padding: 24px; border-radius: 12px; z-index: 2147483647; color: #0f0f0f; font-family: 'YouTube Sans', 'Roboto', sans-serif; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 32px rgba(0, 0, 0, 0.2); border: 1px solid #e0e0e0; display: none;`;
        const title = document.createElement('h2');
        title.textContent = 'YouTubeTool设置';
        title.style.cssText = `margin: 0 0 20px 0; font-size: 20px; font-weight: 500; color: #0f0f0f; padding-bottom: 12px; border-bottom: 1px solid #e0e0e0;`;
        panel.appendChild(title);
        const settings = [
            { key: 'availableSpeeds', label: '可用倍数', type: 'text', description: '速度选择器显示的倍数，用逗号分隔（如：2.5,2.0,1.75,1.5,1.25）' },
            { key: 'defaultSpeedMultiplier', label: '默认倍数', type: 'text', description: '默认加速倍数（如：1.5）' },
            { key: 'persistentModeHoldSpeed', label: '临时右键', type: 'text', description: '持续加速模式下按住右键时的临时倍数（如：3.0）' },
            { key: 'persistentModeLeftHoldSpeed', label: '临时左键', type: 'text', description: '持续加速模式下按住左键时的临时倍数（如：1.0）' },
            { key: 'tempSpeedStep', label: '步频调整', type: 'text', description: '临时倍数状态下单击上下键调整倍数的步长（如：0.25）' },
            { key: 'doubleClickTimeout', label: '双击间隔', type: 'text', description: '双击识别的最大时间间隔（毫秒，如：200）' },
            { key: 'longPressDuration', label: '长按时间', type: 'text', description: '长按触发持续加速模式的时间（毫秒，如：5000）' },
            { key: 'seekTime', label: '短快进退', type: 'text', description: '短按左右键的快进/快退时间（秒，如：5）' },
            { key: 'longSeekTime', label: '长快进退', type: 'text', description: '长按功能键时的快进/快退时间（秒，如：10）' },
            { key: 'controlOpacity', label: '原始透明度', type: 'text', description: '控制面板的原始透明度（0-1之间，如：0.6）' },
            { key: 'indicatorFadeOpacity', label: '淡出透明度', type: 'text', description: '指示器淡出后的透明度（0-1之间，如：0.1）' },
            { key: 'hoverAreaMultiplier', label: '悬停范围', type: 'text', description: '悬停检测区域的倍数（如：1.5）' },
            { key: 'indicatorFadeDelay', label: '淡出延迟', type: 'text', description: '指示器淡出前的延迟时间（毫秒，如：5000）' },
            { key: 'longSeekKey', label: '功能键', type: 'special', description: '长快进功能键，点击设置' },
            { key: 'settingsPanelKey', label: '设置面板快捷键', type: 'special', description: '打开/关闭设置面板的快捷键，点击设置' },
            { key: 'indicatorPosition', label: '速度指示器水平位置', type: 'radio', description: '速度指示器在屏幕上的水平位置' },
            { key: 'indicatorVerticalPosition', label: '指示器垂直位置', type: 'text', description: '速度指示器距离顶部的距离（像素，最小10，最大不超过屏幕高度-50）' }
        ];
        const settingsContainer = document.createElement('div');
        settingsContainer.style.cssText = 'max-height: 50vh; overflow-y: auto; margin-bottom: 20px;';
        settings.forEach(setting => {
            const container = document.createElement('div');
            container.style.cssText = 'margin-bottom: 20px;';
            const label = document.createElement('label');
            label.textContent = setting.label;
            label.style.cssText = 'display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500; color: #0f0f0f;';
            container.appendChild(label);
            if (setting.description) {
                const desc = document.createElement('div');
                desc.textContent = setting.description;
                desc.style.cssText = 'font-size: 12px; color: #606060; margin-bottom: 8px; line-height: 1.4;';
                container.appendChild(desc);
            }
            let input;
            if (setting.type === 'special') {
                input = document.createElement('button');
                input.id = `settings-${setting.key}-button`;
                input.textContent = config[setting.key];
                input.type = 'button';
                input.style.cssText = `width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #dadce0; background: #f8f9fa; color: #0f0f0f; font-size: 14px; cursor: pointer; transition: all 0.2s ease; font-weight: 500;`;
                input.addEventListener('mouseenter', () => !isSettingsKeyRecording && (input.style.background = '#f1f3f4'));
                input.addEventListener('mouseleave', () => !isSettingsKeyRecording && (input.style.background = '#f8f9fa'));
                input.addEventListener('click', (e) => !isSettingsKeyRecording && (setting.key === 'longSeekKey' ? startSettingsKeyRecording(input) : startSettingsPanelKeyRecording(input)));
                if (setting.key === 'longSeekKey') settingsKeyButton = input;
                else if (setting.key === 'settingsPanelKey') settingsPanelKeyButton = input;
            } else if (setting.type === 'radio') {
                const radioContainer = document.createElement('div');
                radioContainer.style.cssText = 'display: flex; gap: 16px;';
                
                const positions = [
                    { value: 'left', label: '左上' },
                    { value: 'center', label: '居中' },
                    { value: 'right', label: '右上' }
                ];
                
                positions.forEach(pos => {
                    const radioWrapper = document.createElement('label');
                    radioWrapper.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer;';
                    
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'indicatorPosition';
                    radio.value = pos.value;
                    radio.checked = config.indicatorPosition === pos.value;
                    radio.addEventListener('change', () => {
                        if (radio.checked) {
                            config.indicatorPosition = pos.value;
                        }
                    });
                    
                    const radioLabel = document.createElement('span');
                    radioLabel.textContent = pos.label;
                    radioLabel.style.cssText = 'font-size: 14px; color: #0f0f0f;';
                    
                    radioWrapper.appendChild(radio);
                    radioWrapper.appendChild(radioLabel);
                    radioContainer.appendChild(radioWrapper);
                });
                
                container.appendChild(radioContainer);
                settingsContainer.appendChild(container);
                return;
            } else {
                input = document.createElement('input');
                input.type = 'text';
                input.value = Array.isArray(config[setting.key]) ? config[setting.key].join(',') : config[setting.key];
                input.style.cssText = `width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #dadce0; background: #ffffff; color: #0f0f0f; font-size: 14px; box-sizing: border-box; transition: border 0.2s ease;`;
                input.addEventListener('focus', () => { input.style.borderColor = '#1a73e8'; input.style.boxShadow = '0 0 0 2px rgba(26, 115, 232, 0.2)'; });
                input.addEventListener('blur', () => { input.style.borderColor = '#dadce0'; input.style.boxShadow = 'none'; });
            }
            input.dataset.settingKey = setting.key;
            container.appendChild(input);
            settingsContainer.appendChild(container);
        });
        panel.appendChild(settingsContainer);
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 12px; padding-top: 16px; border-top: 1px solid #e0e0e0;';
        const resetButton = document.createElement('button');
        resetButton.textContent = '重置默认';
        resetButton.style.cssText = `padding: 10px 20px; background: #f8f9fa; color: #0f0f0f; border: 1px solid #dadce0; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;`;
        resetButton.addEventListener('mouseenter', () => resetButton.style.background = '#f1f3f4');
        resetButton.addEventListener('mouseleave', () => resetButton.style.background = '#f8f9fa');
        resetButton.addEventListener('click', resetSettings);
        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.style.cssText = `padding: 10px 20px; background: #f8f9fa; color: #0f0f0f; border: 1px solid #dadce0; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;`;
        cancelButton.addEventListener('mouseenter', () => cancelButton.style.background = '#f1f3f4');
        cancelButton.addEventListener('mouseleave', () => cancelButton.style.background = '#f8f9fa');
        cancelButton.addEventListener('click', hideSettingsPanel);
        const saveButton = document.createElement('button');
        saveButton.textContent = '保存';
        saveButton.style.cssText = `padding: 10px 20px; background: #cc0000; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s ease;`;
        saveButton.addEventListener('mouseenter', () => saveButton.style.background = '#b30000');
        saveButton.addEventListener('mouseleave', () => saveButton.style.background = '#cc0000');
        saveButton.addEventListener('click', saveSettings);
        buttonContainer.appendChild(resetButton);
        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(saveButton);
        panel.appendChild(buttonContainer);
        panel.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(panel);
        return panel;
    }

    function handleKeyRecording(event, keyType, button, tempKeyValue, onSuccess, onCancel) {
        event.preventDefault();
        event.stopPropagation();
        const key = event.key;
        const conflict = isKeyConflicting(key, keyType);
        if (conflict) { showConflictMessage(conflict); onCancel(button, tempKeyValue); return; }
        config[keyType] = key;
        isSettingsKeyRecording = false;
        button.textContent = key;
        button.style.background = '#f8f9fa';
        button.style.borderColor = '#dadce0';
        button.style.color = '#0f0f0f';
        cleanupSettingsKeyRecording();
        onSuccess();
    }

    function startSettingsKeyRecording(button) {
        if (isSettingsKeyRecording) return;
        isSettingsKeyRecording = true;
        tempLongSeekKey = config.longSeekKey;
        button.textContent = '按下新键...';
        button.style.background = '#fce8e6';
        button.style.borderColor = '#f28b82';
        button.style.color = '#c5221f';
        settingsRecordingTimeoutId = setTimeout(() => cancelSettingsKeyRecording(button), 5000);
        settingsKeyRecordListener = (e) => handleKeyRecording(e, 'longSeekKey', button, tempLongSeekKey, () => updateKeyConfigButton(), cancelSettingsKeyRecording);
        document.addEventListener('keydown', settingsKeyRecordListener, true);
    }

    function startSettingsPanelKeyRecording(button) {
        if (isSettingsKeyRecording) return;
        isSettingsKeyRecording = true;
        const tempSettingsPanelKey = config.settingsPanelKey;
        button.textContent = '按下新键...';
        button.style.background = '#fce8e6';
        button.style.borderColor = '#f28b82';
        button.style.color = '#c5221f';
        settingsRecordingTimeoutId = setTimeout(() => cancelSettingsPanelKeyRecording(button, tempSettingsPanelKey), 5000);
        settingsKeyRecordListener = (e) => handleKeyRecording(e, 'settingsPanelKey', button, tempSettingsPanelKey, () => {}, cancelSettingsPanelKeyRecording);
        document.addEventListener('keydown', settingsKeyRecordListener, true);
    }

    function cancelSettingsKeyRecording(button) {
        isSettingsKeyRecording = false;
        config.longSeekKey = tempLongSeekKey;
        button.textContent = config.longSeekKey;
        button.style.background = '#f8f9fa';
        button.style.borderColor = '#dadce0';
        button.style.color = '#0f0f0f';
        cleanupSettingsKeyRecording();
    }

    function cancelSettingsPanelKeyRecording(button, tempSettingsPanelKey) {
        isSettingsKeyRecording = false;
        config.settingsPanelKey = tempSettingsPanelKey;
        button.textContent = config.settingsPanelKey;
        button.style.background = '#f8f9fa';
        button.style.borderColor = '#dadce0';
        button.style.color = '#0f0f0f';
        cleanupSettingsKeyRecording();
    }

    function cleanupSettingsKeyRecording() {
        clearTimeout(settingsRecordingTimeoutId);
        settingsRecordingTimeoutId = null;
        if (settingsKeyRecordListener) { document.removeEventListener('keydown', settingsKeyRecordListener, true); settingsKeyRecordListener = null; }
    }

    function showSettingsPanel() {
        if (!settingsPanel) settingsPanel = createSettingsPanel();
        updateSettingsPanelInputs();
        settingsOverlay.style.display = 'block';
        settingsPanel.style.display = 'block';
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                if (isSettingsKeyRecording) {
                    const longSeekButton = settingsPanel.querySelector('button[data-setting-key="longSeekKey"]');
                    const settingsPanelButton = settingsPanel.querySelector('button[data-setting-key="settingsPanelKey"]');
                    if (longSeekButton) cancelSettingsKeyRecording(longSeekButton);
                    if (settingsPanelButton) cancelSettingsPanelKeyRecording(settingsPanelButton, config.settingsPanelKey);
                } else hideSettingsPanel();
            }
        };
        document.addEventListener('keydown', escHandler);
        settingsPanel.dataset.escHandler = escHandler;
    }

    function hideSettingsPanel() {
        if (settingsOverlay) settingsOverlay.style.display = 'none';
        if (settingsPanel) {
            settingsPanel.style.display = 'none';
            if (settingsPanel.dataset.escHandler) {
                document.removeEventListener('keydown', settingsPanel.dataset.escHandler);
                delete settingsPanel.dataset.escHandler;
            }
            if (isSettingsKeyRecording) {
                const longSeekButton = settingsPanel.querySelector('button[data-setting-key="longSeekKey"]');
                const settingsPanelButton = settingsPanel.querySelector('button[data-setting-key="settingsPanelKey"]');
                if (longSeekButton) cancelSettingsKeyRecording(longSeekButton);
                if (settingsPanelButton) cancelSettingsPanelKeyRecording(settingsPanelButton, config.settingsPanelKey);
            }
        }
    }

    function saveSettings() {
        const conflict = isKeyConflicting(config.longSeekKey, 'longSeekKey');
        if (conflict) { showConflictMessage(conflict); return; }
        const conflict2 = isKeyConflicting(config.settingsPanelKey, 'settingsPanelKey');
        if (conflict2) { showConflictMessage(conflict2); return; }
        const inputs = settingsPanel.querySelectorAll('input, button[data-setting-key]');
        const newConfig = { ...config };
        inputs.forEach(input => {
            const key = input.dataset.settingKey;
            if (key && key !== 'longSeekKey' && key !== 'settingsPanelKey') {
                if (key === 'availableSpeeds') {
                    const speeds = input.value.split(',').map(s => parseFloat(s.trim())).filter(s => !isNaN(s));
                    // 确保速度数组不为空
                    newConfig[key] = speeds.length > 0 ? speeds : [...defaultConfig.availableSpeeds];
                }
                else if (key === 'indicatorVerticalPosition') {
                    let value = parseFloat(input.value);
                    if (isNaN(value)) value = defaultConfig.indicatorVerticalPosition;
                    value = Math.max(10, Math.min(window.innerHeight - 50, value));
                    newConfig[key] = value;
                } else { 
                    const value = parseFloat(input.value); 
                    newConfig[key] = isNaN(value) ? input.value : value; 
                }
            }
        });
        
        const selectedPosition = settingsPanel.querySelector('input[name="indicatorPosition"]:checked');
        if (selectedPosition) {
            newConfig.indicatorPosition = selectedPosition.value;
        }
        
        if (newConfig.availableSpeeds.length === 0) newConfig.availableSpeeds = defaultConfig.availableSpeeds;
        try { 
            GM_setValue('ytSpeedControlConfig', newConfig); 
        } catch (e) { 
            console.error('保存设置失败:', e);
            showTemporaryMessage('保存设置失败，请检查控制台');
            return;
        }
        Object.assign(config, newConfig);
        if (isActive) {
            if (speedSelection && speedSelection.parentNode) { speedSelection.parentNode.removeChild(speedSelection); speedSelection = null; }
            addSpeedSelectionToPlayer();
            updateSpeedSelection();
            if (speedIndicator && speedIndicator.parentNode) {
                speedIndicator.parentNode.removeChild(speedIndicator);
                speedIndicator = null;
            }
            showSpeedIndicator();
        }
        hideSettingsPanel();
        showTemporaryMessage('设置已保存');
    }

    function resetSettings() {
        try { 
            GM_setValue('ytSpeedControlConfig', null); 
        } catch (e) { 
            console.error('重置设置失败:', e);
            showTemporaryMessage('重置设置失败，请检查控制台');
            return;
        }
        Object.assign(config, defaultConfig);
        if (confirm('设置已重置为默认值，需要重新加载页面以应用更改。是否现在重新加载？')) location.reload(); else hideSettingsPanel();
    }

    function updateSettingsKeyButton() {
        if (settingsKeyButton) {
            settingsKeyButton.textContent = config.longSeekKey;
            settingsKeyButton.style.background = '#f8f9fa';
            settingsKeyButton.style.borderColor = '#dadce0';
            settingsKeyButton.style.color = '#0f0f0f';
        }
        if (settingsPanelKeyButton) {
            settingsPanelKeyButton.textContent = config.settingsPanelKey;
            settingsPanelKeyButton.style.background = '#f8f9fa';
            settingsPanelKeyButton.style.borderColor = '#dadce0';
            settingsPanelKeyButton.style.color = '#0f0f0f';
        }
    }

    function updateSettingsInput(key, value) {
        if (!settingsPanel || settingsPanel.style.display === 'none') return;
        const input = settingsPanel.querySelector(`input[data-setting-key="${key}"]`);
        if (input) input.value = value;
    }

    function updateSettingsPanelInputs() {
        if (!settingsPanel) return;
        const inputs = settingsPanel.querySelectorAll('input[data-setting-key], button[data-setting-key]');
        inputs.forEach(input => {
            const key = input.dataset.settingKey;
            if (key && config.hasOwnProperty(key)) {
                if (Array.isArray(config[key])) { if (input.tagName === 'INPUT') input.value = config[key].join(','); }
                else { if (input.tagName === 'INPUT') input.value = config[key]; else if (input.tagName === 'BUTTON') input.textContent = config[key]; }
            }
        });
        
        const radioButtons = settingsPanel.querySelectorAll('input[name="indicatorPosition"]');
        radioButtons.forEach(radio => {
            radio.checked = radio.value === config.indicatorPosition;
        });
        
        updateSettingsKeyButton();
    }

    // 防抖函数 - 新增
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // 优化的播放器状态检查 - 使用防抖
    const debouncedCheckPlayerState = debounce(() => {
        if (isActive) {
            const playerContainer = document.querySelector('#movie_player, .html5-video-player');
            if (playerContainer && (!speedSelection || !playerContainer.contains(speedSelection))) {
                if (speedSelection && speedSelection.parentNode) {
                    speedSelection.parentNode.removeChild(speedSelection);
                }
                speedSelection = null;
                addSpeedSelectionToPlayer();
            }
            setupVideoEndListener();
            
            // 额外检查：如果不在视频页面但脚本仍激活，则停用
            if (!isVideoPage() && isActive) {
                console.log('定期检查发现不在视频页面，停用脚本');
                deactivateScript();
            }
        }
    }, 500);

    // 脚本生命周期管理 - 增强版本
    function activateScript() {
        if (isActive) return;
        isActive = true;
        addEventListeners();
        addSpeedSelectionToPlayer();
        setupVideoEndListener();
        setupEnhancedPageStateMonitor();

        // 使用防抖的定期检查，减少性能开销
        clearInterval(playerCheckInterval);
        playerCheckInterval = setInterval(debouncedCheckPlayerState, 2000);
    }

    function deactivateScript() {
        if (!isActive) return;
        isActive = false;
        removeEventListeners();
        restoreNormalSpeed();
        resetAllStatesOnVideoEnd();
        isRecordingKey = false;
        cleanupKeyRecording();
        clearTimeout(longSeekLockTimeoutId);

        // 清理所有观察者
        if (videoChangeObserver) {
            videoChangeObserver.disconnect();
            videoChangeObserver = null;
        }
        if (playerResizeObserver) {
            playerResizeObserver.disconnect();
            playerResizeObserver = null;
        }
        if (playerStateObserver) {
            playerStateObserver.disconnect();
            playerStateObserver = null;
        }
        if (playerCheckInterval) {
            clearInterval(playerCheckInterval);
            playerCheckInterval = null;
        }

        [speedSelection, hoverArea].forEach(element => {
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        speedSelection = hoverArea = keyConfigButton = settingsButton = null;

        if (videoEndListener) {
            const video = getVideoElement();
            if (video) video.removeEventListener('ended', videoEndListener);
            videoEndListener = null;
        }
    }

    function checkPageState() {
        if (isVideoPage()) {
            activateScript();
        } else {
            deactivateScript();
        }
    }

    function init() {
        checkPageState();
        let lastUrl = location.href;

        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                checkPageState();
            }
        }).observe(document, {subtree: true, childList: true});

        document.addEventListener('visibilitychange', checkPageState);

        try {
            GM_registerMenuCommand('YouTube Speed Control 设置', showSettingsPanel);
        } catch (e) {
            console.log('无法注册菜单命令');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.addEventListener('beforeunload', () => {
        clearAllTimeouts();
        cleanupKeyRecording();
        if (tempSpeedAdjustInterval) {
            clearInterval(tempSpeedAdjustInterval);
            tempSpeedAdjustInterval = null;
        }
        
        // 清理所有观察者
        if (videoChangeObserver) videoChangeObserver.disconnect();
        if (playerResizeObserver) playerResizeObserver.disconnect();
        if (playerStateObserver) playerStateObserver.disconnect();
        if (playerCheckInterval) clearInterval(playerCheckInterval);
        
        [speedIndicator, hoverArea, settingsPanel, settingsOverlay].forEach(element => {
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
            }
        });
        if (videoEndListener) {
            const video = getVideoElement();
            if (video) video.removeEventListener('ended', videoEndListener);
        }
    });
})();
