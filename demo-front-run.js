#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { createLogger } = require('./src/utils/Logger');

const MONITOR_ADDRESS = (process.env.DEMO_MONITOR || '').toLowerCase();
const logger = createLogger('demo-front-run');

function sanitizeAddress(address) {
    if (!address) {
        throw new Error('缺少必要的地址配置');
    }
    try {
        return ethers.utils.getAddress(address);
    } catch (err) {
        try {
            return ethers.utils.getAddress(address.toLowerCase());
        } catch (lowerErr) {
            throw new Error(`地址校验失败 (${address}): ${lowerErr.message}`);
        }
    }
}

function safeAddress(address, label) {
    if (!address) {
        return null;
    }
    try {
        return ethers.utils.getAddress(address);
    } catch (err) {
        try {
            return ethers.utils.getAddress(address.toLowerCase());
        } catch (lowerErr) {
            logger.warn(`${label} 贿赂地址无效:`, lowerErr.message);
            return null;
        }
    }
}
const BSC_WSS_URL = process.env.BSC_WSS_URL;
const BSC_HTTP_URL = process.env.BSC_HTTP_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const PCS_V2_ROUTER = process.env.PCS_V2_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = sanitizeAddress(process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
const USDT_ADDRESS = sanitizeAddress(process.env.USDT_ADDRESS || '0x55d398326f99059ff775485246999027B3197955');

const BUY_VALUE = ethers.utils.parseEther(process.env.DEMO_BUY_VALUE || '0.00001');
const GAS_LIMIT = ethers.BigNumber.from(process.env.DEMO_GAS_LIMIT || '400000');
const FIXED_GAS_PRICE = ethers.utils.parseUnits(process.env.DEMO_GAS_PRICE_GWEI || '0.1', 'gwei');
const BRIBE_WEI = process.env.BUNDLE_BUILDER_TIP_BNB ? ethers.utils.parseEther(process.env.BUNDLE_BUILDER_TIP_BNB) : ethers.constants.Zero;
const blockzeroTipRaw = process.env.PUISSANT_BUILDER_ADDRESS || '0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20';
const bundle48TipRaw = process.env.BUNDLE48_BUILDER_ADDRESS || '0x4848489f0b2BEdd788c696e2D79b6b69D7484848';
const blockzeroTipAddr = safeAddress(blockzeroTipRaw, '[demo] blockzero');
const bundle48TipAddr = safeAddress(bundle48TipRaw, '[demo] bnb48');
const INCLUDE_TARGET_IN_BUNDLE = (process.env.INCLUDE_TARGET_IN_BUNDLE || 'true').toLowerCase() === 'true';

if (!BSC_WSS_URL) {
    throw new Error('缺少 BSC_WSS_URL');
}
if (!BSC_HTTP_URL) {
    throw new Error('缺少 BSC_HTTP_URL');
}
if (!PRIVATE_KEY) {
    throw new Error('缺少 PRIVATE_KEY');
}

const pcsInterface = new ethers.utils.Interface([
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)'
]);

const httpProvider = new ethers.providers.JsonRpcProvider(BSC_HTTP_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
const wsProvider = new ethers.providers.WebSocketProvider(BSC_WSS_URL);

const blockzeroRpc = process.env.PUISSANT_BUILDER_RPC || 'https://rpc.blockrazor.builders/';
const bundle48Rpc = process.env.BUNDLE48_RPC_URL || 'https://puissant-builder.48.club';
const bundleProviders = [];
if (blockzeroRpc) {
    bundleProviders.push({
        name: 'blockzero',
        provider: new ethers.providers.JsonRpcProvider(blockzeroRpc),
        tipAddress: blockzeroTipAddr,
        spSignature: ''
    });
}
if (bundle48Rpc) {
    bundleProviders.push({
        name: 'bnb48',
        provider: new ethers.providers.JsonRpcProvider(bundle48Rpc),
        tipAddress: bundle48TipAddr,
        spSignature: process.env.BUNDLE48_SP_SIGNATURE || ''
    });
}

if (BRIBE_WEI.gt(0)) {
    const amountBn = ethers.utils.formatEther(BRIBE_WEI);
    const activeBuilders = bundleProviders
        .filter(item => item.tipAddress)
        .map(item => `${item.name}->${item.tipAddress}`)
        .join(', ');
    if (activeBuilders) {
        logger.info(`贿赂交易已开启，单次支付 ${amountBn} BNB，目标: ${activeBuilders}`);
    } else {
        logger.warn(`已设置贿赂金额 ${amountBn} BNB，但未配置有效的 builder 贿赂地址`);
    }
} else {
    logger.warn('未配置 BUNDLE_BUILDER_TIP_BNB，当前不会额外向 builder 支付小费');
}

const handledTx = new Set();
let lastKnownNonce = null;

async function getChainAlignedNonce() {
    const latestNonce = await httpProvider.getTransactionCount(wallet.address, 'latest');
    const pendingNonce = await httpProvider.getTransactionCount(wallet.address, 'pending');

    if (pendingNonce !== latestNonce) {
        logger.warn('警告: pending nonce 与 latest 不一致, 采用最新已上链值', {
            latest: latestNonce,
            pending: pendingNonce
        });
    }

    if (lastKnownNonce !== null && latestNonce < lastKnownNonce) {
        logger.warn('发现最新链上 nonce 低于缓存值, 重置为最新');
    }

    lastKnownNonce = latestNonce;
    return latestNonce;
}

async function main() {
    logger.info('Demo front-runner started. Monitoring:', MONITOR_ADDRESS);
    await wsProvider._subscribe(
        'newPendingTransactions',
        ['newPendingTransactions', true],
        async (tx) => {
            try {
                if (!tx || !tx.from) {
                    return;
                }
                if (tx.from.toLowerCase() !== MONITOR_ADDRESS.toLowerCase()) {
                    return;
                }
                if (handledTx.has(tx.hash)) {
                    return;
                }
                handledTx.add(tx.hash);

                logger.info(`捕获到目标钱包交易 ${tx.hash}, form=${tx.from}, to=${tx.to}`);

                logger.info(`${JSON.stringify(tx, null, 2)}`);

                await frontRun(tx);
            } catch (err) {
                logger.error('处理 pending 交易失败:', err.message);
            }
        }
    );

    wsProvider._websocket.on('close', () => {
        logger.warn('WebSocket 已关闭');
    });

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function frontRun(pendingTx) {
    try {
        const targetRaw = reconstructLegacyTransaction(pendingTx);
        if (INCLUDE_TARGET_IN_BUNDLE) {
            if (!targetRaw) {
                logger.warn('重构原交易失败，已要求带入原交易，放弃此次前置');
                return;
            }
            logger.info('将目标交易一并纳入 bundle');
        } else if (!targetRaw) {
            logger.warn('原交易缺少签名，已忽略（仅发送自家交易）');
        }

        const nonce = await getChainAlignedNonce();
        const deadline = Math.floor(Date.now() / 1000) + 60;
        const path = [WBNB_ADDRESS, USDT_ADDRESS];
        const data = pcsInterface.encodeFunctionData('swapExactETHForTokens', [
            0,
            path,
            wallet.address,
            deadline
        ]);

        const txRequest = {
            to: PCS_V2_ROUTER,
            data,
            value: BUY_VALUE,
            gasLimit: GAS_LIMIT,
            gasPrice: FIXED_GAS_PRICE,
            nonce
        };

        logger.info('构造 front-run 交易:', {
            gasPrice: ethers.utils.formatUnits(FIXED_GAS_PRICE, 'gwei'),
            gasLimit: GAS_LIMIT.toString(),
            value: ethers.utils.formatEther(BUY_VALUE)
        });

        const signedFrontRun = await wallet.signTransaction(txRequest);
        const frontHash = ethers.utils.keccak256(signedFrontRun);
        const tipNonce = nonce + 1;

        const bundlePlans = [];
        for (const builder of bundleProviders) {
            const planTxs = [signedFrontRun];
            if (INCLUDE_TARGET_IN_BUNDLE) {
                planTxs.push(targetRaw);
            }
            if (BRIBE_WEI.gt(0) && builder.tipAddress) {
                try {
                    const tipUnsigned = {
                        to: builder.tipAddress,
                        value: BRIBE_WEI,
                        gasPrice: FIXED_GAS_PRICE,
                        gasLimit: 21000,
                        nonce: tipNonce
                    };
                    const tipSigned = await wallet.signTransaction(tipUnsigned);
                    planTxs.push(tipSigned);
                } catch (err) {
                    logger.warn(`生成贿赂交易失败 -> ${builder.name}:`, err.message);
                }
            }
            bundlePlans.push({ builder, txs: planTxs });
        }

        if (bundlePlans.length === 0) {
            logger.warn('未配置任何私有节点，无法发送捆绑');
            return;
        }

        await sendBundleToProviders(bundlePlans, frontHash);
    } catch (err) {
        logger.error('发送 front-run 交易失败:', err.message);
    }
}

function reconstructLegacyTransaction(tx) {
    try {
        const gasPrice = tx.gasPrice ? ethers.BigNumber.from(tx.gasPrice) : undefined;
        const gasLimit = tx.gasLimit || tx.gas ? ethers.BigNumber.from(tx.gasLimit || tx.gas) : undefined;
        let chainId = tx.chainId;
        if (chainId === undefined || chainId === null) {
            chainId = 56;
        } else if (typeof chainId === 'string') {
            chainId = Number(chainId);
        }
        const txData = {
            nonce: tx.nonce,
            gasPrice,
            gasLimit,
            to: tx.to,
            value: tx.value,
            data: tx.input || tx.data,
            chainId
        };
        const sig = {
            v: typeof tx.v === 'string' ? parseInt(tx.v, 16) : tx.v,
            r: tx.r,
            s: tx.s
        };
        if (!sig.r || !sig.s || !sig.v) {
            logger.warn('pending 交易缺少签名信息');
            return null;
        }
        return ethers.utils.serializeTransaction(txData, sig);
    } catch (err) {
        logger.warn('reconstructLegacyTransaction 失败:', err.message);
        return null;
    }
}

async function sendBundleToProviders(plans, frontHash) {
    const currentBlock = await wsProvider.getBlockNumber();
    const targetBlock = currentBlock + 1;
    const results = await Promise.allSettled(
        plans.map(plan => sendBundleViaBuilder(plan, frontHash, targetBlock, currentBlock))
    );
    const success = results.some(res => res.status === 'fulfilled' && res.value === true);
    if (!success) {
        logger.warn('bundle 未成功发送，放弃');
    }
}

async function sendBundleViaBuilder(plan, frontHash, targetBlockNumber, baseBlockNumber) {
    const { builder, txs } = plan;
    if (!builder || !builder.provider) {
        return false;
    }
    try {
        const params = {
            txs,
            targetBlockNumber,
            maxBlockNumber: Math.max(targetBlockNumber + 12, baseBlockNumber + 12),
            maxTimestamp: Math.floor(Date.now() / 1000) + 60
        };
        if (builder.spSignature) {
            params['48spSign'] = builder.spSignature;
        }
        logger.info(`[${builder.name}] 发送 bundle 请求, targetBlock=${targetBlockNumber}`);
        const response = await builder.provider.send('eth_sendBundle', [params]);
        logger.info(`[${builder.name}] bundle 响应: ${JSON.stringify(response)}`);
        const mined = await waitForInclusion(frontHash, 6000);
        if (mined) {
            logger.info(`[${builder.name}] ✅ front-run 已上链 block ${mined.blockNumber}`);
            return true;
        }
        logger.warn(`[${builder.name}] 在超时时间内未检测到 front-run 上链`);
        return false;
    } catch (err) {
        logger.warn(`[${builder.name}] bundle 发送失败: ${err.message}`);
        const extra = [];
        if (err.code) extra.push(`code=${err.code}`);
        if (err.error && err.error.message) extra.push(`inner=${err.error.message}`);
        if (err.body) extra.push(`body=${err.body}`);
        if (err.data) extra.push(`data=${JSON.stringify(err.data)}`);
        if (extra.length > 0) {
            logger.warn(`[${builder.name}] 失败详情: ${extra.join(' | ')}`);
        }
        return false;
    }
}

async function waitForInclusion(txHash, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const receipt = await httpProvider.getTransactionReceipt(txHash);
        if (receipt) {
            return receipt;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
}


async function shutdown() {
    logger.info('shutting down...');
    try {
        if (wsProvider && wsProvider._websocket) {
            wsProvider._websocket.terminate();
        }
    } catch (err) {
        // ignore
    }
    process.exit(0);
}

main().catch(err => {
    logger.error('Demo 启动失败:', err.message || err);
    process.exit(1);
});
