const { startSniperRuntime } = require('./src/runtime/sniperRuntime');
const { createLogger } = require('./src/utils/Logger');

(async () => {
    const logger = createLogger('block-sniper');
    try {
        logger.info('启动区块监听(block)');
        const runtime = await startSniperRuntime({ listenMode: 'block', logger });
        let stopping = false;
        const shutdown = async () => {
            if (stopping) return;
            stopping = true;
            await runtime.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    } catch (err) {
        logger.error('block-sniper 启动失败:', err.message || err);
        logger.error(err);
        process.exit(1);
    }
})();
