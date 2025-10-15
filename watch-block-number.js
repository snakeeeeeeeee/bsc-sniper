#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
    const url = process.env.BSC_WSS_URL;
    if (!url) {
        throw new Error('缺少 BSC_WSS_URL 环境变量');
    }
    const provider = new ethers.providers.WebSocketProvider(url);
    console.log('[watch-block] 监听最新区块号...');

    provider.on('block', (blockNumber) => {
        const ts = new Date().toISOString();
        console.log(JSON.stringify({ timestamp: ts, blockNumber }));
    });

    provider._websocket.on('close', (code, reason) => {
        console.warn('[watch-block] WebSocket 已关闭', code, reason || '');
    });
    provider._websocket.on('error', (err) => {
        console.error('[watch-block] WebSocket 错误:', err.message || err);
    });

    const shutdown = () => {
        console.log('[watch-block] 停止监听');
        try {
            if (provider && provider._websocket) {
                provider._websocket.terminate();
            }
        } catch (err) {
            console.warn('[watch-block] WebSocket 关闭失败:', err.message);
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('[watch-block] 运行失败:', err.message || err);
    process.exit(1);
});
