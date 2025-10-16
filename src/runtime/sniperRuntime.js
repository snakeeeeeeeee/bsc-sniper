const { ethers } = require('ethers');
const { SwapParseListener } = require('../listener/SwapParseListener');
const { SwapBuyer, registerSwapFollow } = require('../buyer');
const { createLogger } = require('../utils/Logger');

// 启动监听与买入逻辑的统一入口
async function startSniperRuntime(options = {}) {
    const listenMode = options.listenMode;
    const logger = options.logger || createLogger(`sniper:${listenMode || 'auto'}`);
    const wsUrl = options.wsUrl || process.env.BSC_WSS_URL;
    const httpUrl = options.httpUrl || process.env.BSC_HTTP_URL;
    if (!wsUrl && !httpUrl) {
        throw new Error('缺少可用的链节点地址 (BSC_WSS_URL 或 BSC_HTTP_URL)');
    }
    const privateKeysSource = Array.isArray(options.privateKeys)
        ? options.privateKeys
        : (options.privateKeys || process.env.PRIVATE_KEY || '').split(',');
    const privateKeys = privateKeysSource
        .map(pk => pk.trim())
        .filter(Boolean);
    if (privateKeys.length === 0) {
        throw new Error('缺少 PRIVATE_KEY');
    }
    const monitorListSource = Array.isArray(options.monitorAddresses)
        ? options.monitorAddresses
        : (options.monitorAddresses || process.env.MONITOR_ADDRESSES || '').split(',');
    const monitorAddresses = monitorListSource
        .map(addr => addr.trim())
        .filter(Boolean);

    logger.info(`启动 sniper，监听模式=${listenMode || 'auto'}，监控地址数=${monitorAddresses.length}`);

    const provider = wsUrl
        ? new ethers.providers.WebSocketProvider(wsUrl)
        : new ethers.providers.JsonRpcProvider(httpUrl);
    logger.info(`SwapBuyer provider 类型=${wsUrl ? 'ws' : 'http'}`);
    const buyer = new SwapBuyer({ provider, privateKeys });
    const unregister = registerSwapFollow(buyer, { logger });

    const listener = new SwapParseListener(monitorAddresses, { listenMode });
    await listener.start();

    let stopped = false;
    const stop = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        logger.warn('sniper 正在停止...');
        try {
            unregister?.();
        } catch (err) {
            logger.error('取消事件订阅失败:', err.message || err);
        }
        try {
            if (listener.wsProvider && listener.wsProvider._websocket) {
                listener.wsProvider._websocket.terminate();
            }
        } catch (err) {
            logger.error('关闭监听 WebSocket 失败:', err.message || err);
        }
        try {
            if (provider._websocket && provider._websocket.terminate) {
                provider._websocket.terminate();
            }
        } catch (err) {
            logger.error('关闭买单 WebSocket 失败:', err.message || err);
        }
    };

    return {
        listener,
        buyer,
        stop,
        logger
    };
}

module.exports = {
    startSniperRuntime
};
