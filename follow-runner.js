#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { SwapParseListener } = require('./src/listener/SwapParseListener');
const { SwapBuyer, registerSwapFollow } = require('./src/buyer');

async function main() {
    const httpUrl = process.env.BSC_HTTP_URL;
    const privateKeyRaw = process.env.PRIVATE_KEY || '';
    if (!httpUrl) {
        throw new Error('缺少 BSC_HTTP_URL');
    }
    if (!privateKeyRaw) {
        throw new Error('缺少 PRIVATE_KEY');
    }
    const privateKeys = privateKeyRaw
        .split(',')
        .map(pk => pk.trim())
        .filter(Boolean);
    if (privateKeys.length === 0) {
        throw new Error('未解析到任何私钥');
    }

    const provider = new ethers.providers.JsonRpcProvider(httpUrl);
    const buyer = new SwapBuyer({ provider, privateKeys });
    registerSwapFollow(buyer);

    const monitorList = (process.env.MONITOR_ADDRESSES || '')
        .split(',')
        .map(addr => addr.trim())
        .filter(Boolean);
    const listener = new SwapParseListener(monitorList);
    await listener.start();

    const shutdown = async () => {
        console.log('[follow-runner] shutting down...');
        try {
            if (listener.wsProvider && listener.wsProvider._websocket) {
                listener.wsProvider._websocket.terminate();
            }
        } catch (err) {
            console.error('关闭 WebSocket 失败:', err.message);
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch(err => {
        console.error('[follow-runner] 运行失败:', err.message || err);
        process.exit(1);
    });
}
