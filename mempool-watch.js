#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        addresses: []
    };
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith('--')) {
            continue;
        }
        if (arg === '--address' || arg === '--addr') {
            const value = args[i + 1];
            if (!value) {
                throw new Error('缺少 --address 参数值');
            }
            config.addresses.push(value);
            i += 1;
        } else if (arg === '--addresses') {
            const value = args[i + 1];
            if (!value) {
                throw new Error('缺少 --addresses 参数值');
            }
            config.addresses.push(...value.split(',').map(v => v.trim()).filter(Boolean));
            i += 1;
        } else if (arg === '--help' || arg === '-h') {
            config.help = true;
        }
    }
    return config;
}

function printUsage() {
    console.log('用法: node mempool-watch.js --address <wallet> [--address <wallet2> ...]');
    console.log('环境变量: BSC_WSS_URL (必需)');
}

function normalizeAddresses(list) {
    return list
        .map(addr => addr.trim())
        .filter(Boolean)
        .map(addr => addr.toLowerCase());
}

function parseTx(tx) {
    const parsed = Object.assign({}, tx);
    if (parsed.gasPrice && ethers.BigNumber.isBigNumber(parsed.gasPrice)) {
        parsed.gasPrice = parsed.gasPrice.toString();
    }
    if (parsed.gas && ethers.BigNumber.isBigNumber(parsed.gas)) {
        parsed.gas = parsed.gas.toString();
    }
    if (parsed.gasLimit && ethers.BigNumber.isBigNumber(parsed.gasLimit)) {
        parsed.gasLimit = parsed.gasLimit.toString();
    }
    if (parsed.value && ethers.BigNumber.isBigNumber(parsed.value)) {
        parsed.value = parsed.value.toString();
    }
    if (parsed.maxFeePerGas && ethers.BigNumber.isBigNumber(parsed.maxFeePerGas)) {
        parsed.maxFeePerGas = parsed.maxFeePerGas.toString();
    }
    if (parsed.maxPriorityFeePerGas && ethers.BigNumber.isBigNumber(parsed.maxPriorityFeePerGas)) {
        parsed.maxPriorityFeePerGas = parsed.maxPriorityFeePerGas.toString();
    }
    return parsed;
}

async function main() {
    const { addresses, help } = parseArgs();
    if (help) {
        printUsage();
        process.exit(0);
    }
    if (!addresses || addresses.length === 0) {
        console.error('缺少监听地址，可使用 --address 指定');
        printUsage();
        process.exit(1);
    }
    const watchList = normalizeAddresses(addresses);
    const url = process.env.BSC_WSS_URL;
    if (!url) {
        throw new Error('缺少 BSC_WSS_URL 环境变量');
    }
    const provider = new ethers.providers.WebSocketProvider(url);

    console.log(`[mempool-watch] 启动，监听地址: ${watchList.join(', ')}`);

    await provider._subscribe(
        'newPendingTransactions',
        ['newPendingTransactions', true],
        async (tx) => {
            try {
                if (!tx || !tx.from) {
                    return;
                }
                const fromLower = tx.from.toLowerCase();
                if (!watchList.includes(fromLower)) {
                    return;
                }
                const parsed = parseTx(tx);
                console.log('[mempool-watch] 捕获交易:');
                console.log(JSON.stringify(parsed, null, 2));
            } catch (err) {
                console.error('[mempool-watch] 处理交易失败:', err.message || err);
            }
        }
    );

    provider._websocket.on('close', (code, reason) => {
        console.warn('[mempool-watch] WebSocket 已关闭', code, reason || '');
    });
    provider._websocket.on('error', (err) => {
        console.error('[mempool-watch] WebSocket 错误:', err.message || err);
    });

    const shutdown = () => {
        console.log('[mempool-watch] 关闭监听...');
        try {
            if (provider && provider._websocket) {
                provider._websocket.terminate();
            }
        } catch (err) {
            console.warn('[mempool-watch] 关闭 WebSocket 失败:', err.message);
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('[mempool-watch] 运行失败:', err.message || err);
    process.exit(1);
});
