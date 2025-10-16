#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { SwapParseListener } = require('./src/listener/SwapParseListener');
const { SwapBuyer, registerSwapFollow } = require('./src/buyer');

async function main() {
    const wsUrl = process.env.BSC_WSS_URL;
    const httpUrl = process.env.BSC_HTTP_URL;
    const privateKeyRaw = process.env.PRIVATE_KEY || '';
    if (!wsUrl && !httpUrl) {
        throw new Error('缺少 BSC_WSS_URL 或 BSC_HTTP_URL');
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

    const provider = wsUrl
        ? new ethers.providers.WebSocketProvider(wsUrl)
        : new ethers.providers.JsonRpcProvider(httpUrl);
    console.log(`[follow-runner] buyer provider 类型=${wsUrl ? 'ws' : 'http'}`);
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
            console.error('关闭监听 WebSocket 失败:', err.message);
        }
        try {
            if (provider._websocket && provider._websocket.terminate) {
                provider._websocket.terminate();
            }
        } catch (err) {
            console.error('关闭买单 WebSocket 失败:', err.message);
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
