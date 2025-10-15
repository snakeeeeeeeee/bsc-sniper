#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { createLogger } = require('./src/utils/Logger');

const logger = createLogger('self-tx');

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {};
    for (let i = 0; i < args.length; i += 1) {
        const key = args[i];
        if (!key.startsWith('--')) {
            continue;
        }
        const value = args[i + 1];
        switch (key) {
        case '--count':
            config.count = Number(value);
            i += 1;
            break;
        case '--gas':
            config.gas = value;
            i += 1;
            break;
        case '--delay':
            config.delay = Number(value);
            i += 1;
            break;
        default:
            logger.warn(`未知参数 ${key}，已忽略`);
            break;
        }
    }
    return config;
}

async function main() {
    const { count, gas, delay } = parseArgs();

    const rpcUrl = process.env.BSC_HTTP_URL;
    const pk = process.env.DEMO_MONITOR_PRIVATE_KEY;
    if (!rpcUrl) {
        throw new Error('缺少 BSC_HTTP_URL');
    }
    if (!pk) {
        throw new Error('缺少 DEMO_MONITOR_PRIVATE_KEY');
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(pk, provider);

    const gasPriceGwei = gas || process.env.SELF_TX_GAS_PRICE_GWEI || '0.1';
    const gasLimit = ethers.BigNumber.from(process.env.SELF_TX_GAS_LIMIT || '21000');
    const totalCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : Number(process.env.SELF_TX_COUNT || 1);
    const gapMs = Number.isFinite(delay) && delay >= 0 ? delay : Number(process.env.SELF_TX_DELAY_MS || 1000);

    const gasPrice = ethers.utils.parseUnits(gasPriceGwei, 'gwei');

    logger.info('开始发送自测交易', {
        钱包: wallet.address,
        次数: totalCount,
        GasPriceGwei: gasPriceGwei,
        GasLimit: gasLimit.toString(),
        间隔毫秒: gapMs
    });

    for (let idx = 0; idx < totalCount; idx += 1) {
        try {
            const txRequest = {
                to: wallet.address,
                value: ethers.constants.Zero,
                gasPrice,
                gasLimit
            };
            const tx = await wallet.sendTransaction(txRequest);
            logger.info(`第 ${idx + 1} 笔交易已广播`, tx.hash);
        } catch (err) {
            logger.error(`第 ${idx + 1} 笔交易发送失败:`, err.message);
            break;
        }
        if (idx < totalCount - 1 && gapMs > 0) {
            await new Promise(resolve => setTimeout(resolve, gapMs));
        }
    }

    logger.info('自测交易流程结束');
}

main().catch(err => {
    logger.error('脚本执行失败:', err.message || err);
    process.exit(1);
});
