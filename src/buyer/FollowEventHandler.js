const {swapEventBus} = require('../events/SwapEventBus');
const {createLogger} = require('../utils/Logger');

function registerSwapFollow(buyer, options = {}) {
    if (!buyer || typeof buyer.execute !== 'function') {
        throw new Error('registerSwapFollow 需要传入有效的 SwapBuyer 实例');
    }
    const filter = options.filter;
    const logger = options.logger || createLogger('SwapFollow');
    const handler = async (payload) => {
        const {model} = payload;
        if (!model) {
            return;
        }
        try {
            if (filter && !filter(model, payload)) {
                return;
            }
            logger.info(`收到 swap 事件: 协议=${model.protocol} 方法=${model.method} 动作=${model.action} tx=${model.txHash || '未知'}`);
            //logger.info(`收到 swap 事件: ${JSON.stringify(payload)}`);
            const results = await buyer.execute(model, {
                pendingTx: payload.pendingTx,
                parserResult: payload.parserResult,
                meta: payload.meta
            });
            for (const result of results) {
                const baseMsg = `钱包=${result.wallet || 'N/A'} 协议=${result.protocol} 方法=${result.method} 动作=${result.action}`;
                if (result.status === 'submitted') {
                    const extra = result.bundle ? ' (bundle)' : '';
                    logger.info(`${baseMsg} 已提交买单 tx=${result.txHash}${extra}`);
                } else if (result.status === 'failed') {
                    logger.error(`${baseMsg} 买单失败: ${result.error}`);
                } else {
                    logger.warn(`${baseMsg} 跳过执行: ${result.reason || result.status}`);
                }
            }
            swapEventBus.emit('swap.follow.executed', {
                model,
                results
            });
        } catch (err) {
            logger.error('执行买入失败:', err.message || err);
            //logger.error(err);
            swapEventBus.emit('swap.follow.error', {
                model,
                error: err
            });
        }
    };
    swapEventBus.on('swap.parsed', handler);
    return () => swapEventBus.off('swap.parsed', handler);
}

module.exports = {
    registerSwapFollow
};
