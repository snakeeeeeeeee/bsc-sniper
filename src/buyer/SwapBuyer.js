const { ethers } = require('ethers');
const { createLogger } = require('../utils/Logger');
const PancakeV2Strategy = require('./strategies/PancakeV2Strategy');
const PancakeV3Strategy = require('./strategies/PancakeV3Strategy');
const BinanceRouterStrategy = require('./strategies/BinanceRouterStrategy');
const MemeProxyStrategy = require('./strategies/MemeProxyStrategy');
const FourMemeStrategy = require('./strategies/FourMemeStrategy');
const { normalizeAddress } = require('./helpers');

function parseBoolean(input, defaultValue = false) {
    if (input === undefined || input === null) {
        return defaultValue;
    }
    const normalized = String(input).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }
    return defaultValue;
}

function safeAddress(address) {
    if (!address) {
        return null;
    }
    try {
        return ethers.utils.getAddress(address);
    } catch (err) {
        try {
            return ethers.utils.getAddress(String(address).toLowerCase());
        } catch (inner) {
            return null;
        }
    }
}

function normalizePendingTx(tx) {
    if (!tx) {
        return null;
    }
    const normalized = Object.assign({}, tx);
    const dataCandidate = (tx.data && tx.data !== '0x') ? tx.data : tx.input;
    if (dataCandidate) {
        normalized.data = dataCandidate;
        normalized.input = dataCandidate;
    }
    if (normalized.value === undefined || normalized.value === null) {
        normalized.value = '0x0';
    }
    return normalized;
}

function toNumberLike(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'number') {
        return value;
    }
    try {
        return ethers.BigNumber.from(value).toNumber();
    } catch (err) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
}

function toBigNumber(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    try {
        return ethers.BigNumber.from(value);
    } catch (err) {
        return undefined;
    }
}

function serializePendingTx(tx) {
    if (!tx) {
        return null;
    }
    const v = tx.v;
    const r = tx.r;
    const s = tx.s;
    if (!v || !r || !s) {
        return null;
    }
    try {
        const chainIdRaw = tx.chainId !== undefined && tx.chainId !== null ? tx.chainId : 56;
        const chainId = typeof chainIdRaw === 'string' ? (chainIdRaw.startsWith('0x') ? parseInt(chainIdRaw, 16) : Number(chainIdRaw)) : chainIdRaw;
        const gasLimit = toBigNumber(tx.gasLimit || tx.gas || tx.gasUsed);
        const gasPrice = toBigNumber(tx.gasPrice);
        const maxFeePerGas = toBigNumber(tx.maxFeePerGas);
        const maxPriorityFeePerGas = toBigNumber(tx.maxPriorityFeePerGas);
        const nonce = toNumberLike(tx.nonce);
        const value = toBigNumber(tx.value) || ethers.constants.Zero;
        const data = tx.data || tx.input || '0x';
        const base = {
            nonce,
            to: tx.to,
            value,
            data,
            chainId,
            gasLimit
        };
        if (maxFeePerGas && maxPriorityFeePerGas) {
            base.type = 2;
            base.maxFeePerGas = maxFeePerGas;
            base.maxPriorityFeePerGas = maxPriorityFeePerGas;
            if (Array.isArray(tx.accessList)) {
                base.accessList = tx.accessList;
            }
        } else if (gasPrice) {
            base.gasPrice = gasPrice;
        }
        const sig = {
            v: typeof v === 'string' ? (v.startsWith('0x') ? parseInt(v, 16) : Number(v)) : (ethers.BigNumber.isBigNumber(v) ? v.toNumber() : v),
            r,
            s
        };
        return ethers.utils.serializeTransaction(base, sig);
    } catch (err) {
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class SwapBuyer {
    constructor({ provider, privateKeys = [], config = {} }) {
        if (!provider) {
            throw new Error('SwapBuyer 需要 provider');
        }
        this.provider = provider;
        const { logger: providedLogger, ...restConfig } = config;
        this.logger = providedLogger || createLogger('SwapBuyer');
        const dryRunFlag = Object.prototype.hasOwnProperty.call(restConfig, 'dryRun')
            ? config.dryRun
            : (process.env.BUY_DRY_RUN ? String(process.env.BUY_DRY_RUN).toLowerCase() === 'true' : false);
        this.config = Object.assign({
            slippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || '5000'),
            deadlineSeconds: Number(process.env.DEFAULT_DEADLINE_SEC || '60'),
            approvalOptions: {},
            gasLimit: process.env.GAS_LIMIT ? ethers.BigNumber.from(process.env.GAS_LIMIT) : null,
            gasPriceGwei: process.env.GAS_PRICE ? Number(process.env.GAS_PRICE) : null,
            buyValueBnb: ethers.utils.parseEther(process.env.BUY_VALUE_BNB || process.env.BUNDLE_BUY_VALUE_BNB || '0.00001'),
            buyValueUsd: process.env.BUY_VALUE_USD || '0.01',
            simulateBeforeSend: parseBoolean(process.env.SIMULATE_BEFORE_BUY, false),
            forceZeroMinOut: parseBoolean(process.env.FORCE_MIN_OUT_ZERO, false),
            dryRun: dryRunFlag
        }, restConfig);
        this.wallets = privateKeys
            .map(pk => pk.trim())
            .filter(Boolean)
            .map(pk => new ethers.Wallet(pk, provider));
        if (this.wallets.length === 0) {
            throw new Error('SwapBuyer 需要至少一个私钥');
        }
        this.strategies = [
            new PancakeV2Strategy(),
            new PancakeV3Strategy(),
            new BinanceRouterStrategy(),
            new MemeProxyStrategy(),
            new FourMemeStrategy()
        ];
        this.bundleConfig = this.buildBundleConfig();
        this.nonceCache = new Map();
    }

    pickStrategy(parseModel) {
        for (const strategy of this.strategies) {
            if (strategy.supports(parseModel)) {
                return strategy;
            }
        }
        throw new Error(`未找到匹配策略: ${parseModel.protocol}/${parseModel.method}`);
    }

    determineOverrideAmount(parseModel) {
        const action = (parseModel.action || '').toLowerCase();
        // todo
        if (action !== 'buy') {
            return null;
        }
        const spendToken = parseModel.amounts?.spend?.token || {};
        const address = normalizeAddress(spendToken.address);
        const symbol = (spendToken.symbol || '').toUpperCase();
        const decimals = Number.isFinite(spendToken.decimals) ? spendToken.decimals : 18;
        if (!address || address === ethers.constants.AddressZero || symbol === 'BNB') {
            return {
                amount: this.config.buyValueBnb,
                spendToken: ethers.constants.AddressZero
            };
        }
        if (symbol === 'WBNB') {
            return {
                amount: this.config.buyValueBnb,
                spendToken: address
            };
        }
        if (symbol === 'USDT' || symbol === 'USDC') {
            const amount = ethers.utils.parseUnits(this.config.buyValueUsd, decimals);
            return {
                amount,
                spendToken: address
            };
        }
        return null;
    }

    buildBundleConfig() {
        const tipWei = process.env.BUNDLE_BUILDER_TIP_BNB
            ? ethers.utils.parseEther(process.env.BUNDLE_BUILDER_TIP_BNB)
            : ethers.constants.Zero;
        const blockzeroRpc = process.env.PUISSANT_BUILDER_RPC || 'https://rpc.blockrazor.builders/';
        const bundle48Rpc = process.env.BUNDLE48_RPC_URL || 'https://puissant-builder.48.club';
        const blockzeroTip = safeAddress(process.env.PUISSANT_BUILDER_ADDRESS || '0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20');
        const bundle48Tip = safeAddress(process.env.BUNDLE48_BUILDER_ADDRESS || '0x4848489f0b2BEdd788c696e2D79b6b69D7484848');

        const providers = [];
        if (blockzeroRpc) {
            providers.push({
                name: 'blockzero',
                provider: new ethers.providers.JsonRpcProvider(blockzeroRpc),
                tipAddress: blockzeroTip,
                spSignature: ''
            });
        }
        if (bundle48Rpc) {
            providers.push({
                name: 'bnb48',
                provider: new ethers.providers.JsonRpcProvider(bundle48Rpc),
                tipAddress: bundle48Tip,
                spSignature: process.env.BUNDLE48_SP_SIGNATURE || ''
            });
        }

        const enabled = parseBoolean(process.env.BUNDLE_ENABLED, true) && providers.length > 0;
        const includeTarget = parseBoolean(process.env.BUNDLE_INCLUDE_TARGET, false);
        const cfg = {
            enabled,
            includeTarget,
            tipWei,
            targetBlockOffset: Number(process.env.BUNDLE_BLOCK_OFFSET || '1'),
            maxBlockDelta: Number(process.env.BUNDLE_MAX_BLOCKS || '12'),
            maxTimestampSeconds: Number(process.env.BUNDLE_MAX_TIMESTAMP_SEC || '60'),
            waitForMs: Number(process.env.BUNDLE_WAIT_MS || '6000'),
            providers
        };

        if (cfg.enabled) {
            const builderList = providers.map(it => it.name).join(', ');
            const tipInfo = tipWei.gt(0) ? `，小费=${ethers.utils.formatEther(tipWei)} BNB` : '';
            this.logger.info(`bundle 模式已启用，builder=${builderList}${tipInfo}`);
        } else {
            this.logger.warn('bundle 模式未启用或缺少 builder 配置，将使用普通发送');
        }
        return cfg;
    }

    async ensureFullPendingTx(pendingTx) {
        const normalized = normalizePendingTx(pendingTx);
        if (!normalized) {
            return null;
        }
        const hasSignature = normalized.r && normalized.s && normalized.v;
        this.logger.info(`[pending-check] hash=${normalized.hash || 'unknown'} hasSig=${!!hasSignature}`);
        if (normalized.r && normalized.s && normalized.v) {
            return normalized;
        }
        if (!normalized.hash) {
            return null;
        }
        try {
            const fetched = await this.provider.getTransaction(normalized.hash);
            if (!fetched) {
                return null;
            }
            const merged = normalizePendingTx(Object.assign({}, fetched));
            const afterSig = merged && merged.r && merged.s && merged.v;
            this.logger.info(`[pending-fetch] hash=${normalized.hash} success=${!!merged} hasSig=${!!afterSig}`);
            return merged;
        } catch (err) {
            this.logger.warn(`获取完整 pending 交易失败: ${err.message || err}`);
            return null;
        }
    }

    async reserveNonce(wallet) {
        const addr = wallet.address.toLowerCase();
        const cached = this.nonceCache.get(addr);
        if (cached && cached.nextNonce !== undefined && !cached.locked) {
            cached.locked = true;
            cached.lastUpdate = Date.now();
            this.nonceCache.set(addr, cached);
            this.logger.info(`[nonce-cache] hit wallet=${wallet.address} nonce=${cached.nextNonce}`);
            return cached.nextNonce;
        }
        const start = Date.now();
        const [latest, pending] = await Promise.all([
            this.provider.getTransactionCount(wallet.address, 'latest'),
            this.provider.getTransactionCount(wallet.address, 'pending')
        ]);
        const elapsed = Date.now() - start;
        this.nonceCache.set(addr, {
            nextNonce: latest,
            locked: true,
            lastUpdate: Date.now()
        });
        if (pending !== latest) {
            this.logger.warn(`nonce 不一致，将使用 latest。wallet=${wallet.address} latest=${latest} pending=${pending} 耗时=${elapsed}ms`);
        } else {
            this.logger.info(`[nonce-rpc] wallet=${wallet.address} latest=${latest} 耗时=${elapsed}ms`);
        }
        return latest;
    }

    markNonceSuccess(wallet, nonce) {
        const addr = wallet.address.toLowerCase();
        const cached = this.nonceCache.get(addr) || {};
        cached.nextNonce = (nonce || 0) + 1;
        cached.locked = false;
        cached.lastUpdate = Date.now();
        this.nonceCache.set(addr, cached);
        this.logger.info(`[nonce-commit] wallet=${wallet.address} next=${cached.nextNonce}`);
    }

    markNonceFailure(wallet) {
        const addr = wallet.address.toLowerCase();
        const cached = this.nonceCache.get(addr);
        if (cached) {
            cached.nextNonce = undefined;
            cached.locked = false;
            cached.lastUpdate = Date.now();
            this.nonceCache.set(addr, cached);
            this.logger.warn(`[nonce-reset] wallet=${wallet.address}`);
        }
    }

    async waitForInclusion(txHash, timeoutMs = 6000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const receipt = await this.provider.getTransactionReceipt(txHash);
                if (receipt) {
                    return receipt;
                }
            } catch (err) {
                this.logger.warn(`查询交易回执失败: ${err.message || err}`);
            }
            await sleep(300);
        }
        return null;
    }

    async executeBundle({ wallet, txRequest, targetRaw }) {
        try {
            const bundleStart = Date.now();
            this.logger.info(`[bundle-start] wallet=${wallet.address} includeTarget=${this.bundleConfig.includeTarget && !!targetRaw}`);
            const chainId = await wallet.getChainId();
            const nonce = await this.reserveNonce(wallet);
            this.logger.info(`[bundle-nonce] wallet=${wallet.address} chainId=${chainId} nonce=${nonce}`);
            const txForSign = Object.assign({}, txRequest, {
                nonce,
                chainId
            });
            if (!txForSign.gasLimit) {
                txForSign.gasLimit = await wallet.estimateGas(Object.assign({}, txForSign));
                this.logger.info(`[bundle-gas-estimate] wallet=${wallet.address} gasLimit=${txForSign.gasLimit.toString()}`);
            }

            const signedFrontRun = await wallet.signTransaction(txForSign);
            const frontHash = ethers.utils.keccak256(signedFrontRun);
            const gasPriceLike = txForSign.gasPrice || txForSign.maxFeePerGas;
            if (!gasPriceLike) {
                throw new Error('缺少 gasPrice，无法构建 bundle');
            }
            this.logger.info(`[bundle-sign] wallet=${wallet.address} frontHash=${frontHash}`);

            const plans = [];
            for (const builder of this.bundleConfig.providers) {
                const txs = [signedFrontRun];
                if (this.bundleConfig.includeTarget && targetRaw) {
                    txs.push(targetRaw);
                }
                if (this.bundleConfig.tipWei.gt(0) && builder.tipAddress) {
                    const tipTx = {
                        to: builder.tipAddress,
                        value: this.bundleConfig.tipWei,
                        gasPrice: gasPriceLike,
                        gasLimit: ethers.BigNumber.from(21000),
                        nonce: nonce + 1,
                        chainId
                    };
                    const tipSigned = await wallet.signTransaction(tipTx);
                    txs.push(tipSigned);
                }
                plans.push({ builder, txs });
                this.logger.info(`[bundle-plan] builder=${builder.name} txCount=${txs.length}`);
            }
            if (plans.length === 0) {
                return { success: false, error: '未配置 builder，无法发送 bundle' };
            }

            const currentBlock = await this.provider.getBlockNumber();
            const targetBlockNumber = currentBlock + (this.bundleConfig.targetBlockOffset || 1);
            const maxBlockNumber = targetBlockNumber + (this.bundleConfig.maxBlockDelta || 12);
            const maxTimestamp = Math.floor(Date.now() / 1000) + (this.bundleConfig.maxTimestampSeconds || 60);
            this.logger.info(`[bundle-meta] wallet=${wallet.address} currentBlock=${currentBlock} targetBlock=${targetBlockNumber}`);

            const successBuilders = [];
            const errors = [];
            for (const plan of plans) {
                const params = {
                    txs: plan.txs,
                    targetBlockNumber,
                    maxBlockNumber,
                    maxTimestamp
                };
                if (plan.builder.spSignature) {
                    params['48spSign'] = plan.builder.spSignature;
                }
                const sendStart = Date.now();
                this.logger.info(`[bundle-send] builder=${plan.builder.name} targetBlock=${targetBlockNumber}`);
                try {
                    const response = await plan.builder.provider.send('eth_sendBundle', [params]);
                    successBuilders.push({ name: plan.builder.name, response });
                    const sendElapsed = Date.now() - sendStart;
                    this.logger.info(`[bundle-send] builder=${plan.builder.name} 成功 耗时=${sendElapsed}ms response=${JSON.stringify(response)}`);
                } catch (err) {
                    errors.push({ name: plan.builder.name, error: err });
                    const sendElapsed = Date.now() - sendStart;
                    const detail = err?.body || err?.error?.message || '';
                    this.logger.warn(`[bundle-send] builder=${plan.builder.name} 失败: ${err.message || err} detail=${detail} 耗时=${sendElapsed}ms`);
                }
            }

            if (successBuilders.length === 0) {
                this.markNonceFailure(wallet);
                const last = errors[errors.length - 1]?.error;
                return {
                    success: false,
                    error: last ? (last.message || String(last)) : '所有 builder 均拒绝 bundle'
                };
            }

            const waitStart = Date.now();
            const receipt = await this.waitForInclusion(frontHash, this.bundleConfig.waitForMs || 6000);
            if (!receipt) {
                this.markNonceFailure(wallet);
                const waitElapsed = Date.now() - waitStart;
                this.logger.warn(`[bundle-wait] wallet=${wallet.address} frontHash=${frontHash} 未确认 耗时=${waitElapsed}ms`);
                return {
                    success: false,
                    error: 'bundle 未在超时时间内落块',
                    builders: successBuilders
                };
            }
            const waitElapsed = Date.now() - waitStart;
            const totalElapsed = Date.now() - bundleStart;
            this.logger.info(`[bundle-wait] wallet=${wallet.address} frontHash=${frontHash} 成功 block=${receipt.blockNumber} 耗时=${waitElapsed}ms 总耗时=${totalElapsed}ms`);
            this.markNonceSuccess(wallet, nonce);

            return {
                success: true,
                txHash: frontHash,
                builders: successBuilders,
                receipt
            };
        } catch (err) {
            this.markNonceFailure(wallet);
            return {
                success: false,
                error: err.message || String(err)
            };
        }
    }

    async resolveGasPrice() {
        if (this.config.gasPriceGwei) {
            return ethers.utils.parseUnits(String(this.config.gasPriceGwei), 'gwei');
        }
        return this.provider.getGasPrice();
    }

    async execute(parseModel, context = {}) {
        const action = (parseModel.action || '').toLowerCase();
        if (action !== 'buy') {
            return [{
                wallet: null,
                protocol: parseModel.protocol,
                method: parseModel.method,
                action: parseModel.action,
                status: 'skipped',
                reason: 'action is not buy'
            }];
        }
        const strategy = this.pickStrategy(parseModel);
        const override = this.determineOverrideAmount(parseModel);
        if (!override) {
            return [{
                wallet: null,
                protocol: parseModel.protocol,
                method: parseModel.method,
                action: parseModel.action,
                status: 'skipped',
                reason: 'unsupported spend token'
            }];
        }
        const pendingContext = this.bundleConfig.enabled ? normalizePendingTx(context?.pendingTx) : null;
        let targetPendingTx = null;
        let targetRaw = null;
        let bundleSetupError = null;
        if (this.bundleConfig.enabled && !this.config.dryRun) {
            if (!pendingContext) {
                bundleSetupError = '缺少 pendingTx 数据，无法构建 bundle';
            } else {
                if (this.bundleConfig.includeTarget) {
                    targetPendingTx = await this.ensureFullPendingTx(pendingContext);
                    if (!targetPendingTx) {
                        bundleSetupError = '未能获取完整的目标交易';
                    } else {
                        targetRaw = serializePendingTx(targetPendingTx);
                        if (!targetRaw) {
                            bundleSetupError = '目标交易缺少签名信息，无法序列化';
                        }
                    }
                } else {
                    targetPendingTx = pendingContext;
                }
            }
        }

        if (this.bundleConfig.enabled && !this.config.dryRun && bundleSetupError) {
            return this.wallets.map(wallet => ({
                wallet: wallet.address,
                protocol: parseModel.protocol,
                method: parseModel.method,
                action: parseModel.action,
                status: 'failed',
                error: bundleSetupError
            }));
        }

        const startAll = Date.now();
        this.logger.info(`[execute] 协议=${parseModel.protocol}/${parseModel.method} 动作=${parseModel.action} override=${override.amount.toString()} bundle=${this.bundleConfig.enabled}`);
        const results = [];
        for (const wallet of this.wallets) {
            const startWallet = Date.now();
            const context = {
                provider: this.provider,
                wallet,
                config: this.config,
                overrideAmountIn: override.amount
            };
            try {
                const buildStart = Date.now();
                const build = await strategy.buildTx(parseModel, context);
                const buildElapsed = Date.now() - buildStart;
                this.logger.info(`[build] wallet=${wallet.address} 协议=${parseModel.protocol}/${parseModel.method} 耗时=${buildElapsed}ms`);
                if (!build || build.skip) {
                    results.push({
                        wallet: wallet.address,
                        protocol: parseModel.protocol,
                        method: parseModel.method,
                        action: parseModel.action,
                        status: 'skipped',
                        reason: build?.reason || 'strategy skip'
                    });
                    continue;
                }
                const gasPrice = await this.resolveGasPrice();
                const txRequest = Object.assign({}, build.tx, {
                    from: wallet.address,
                    gasPrice
                });
                this.logger.info(`[tx] wallet=${wallet.address} gasPrice=${gasPrice.toString()} gasLimit=${txRequest.gasLimit ? txRequest.gasLimit.toString() : 'auto'} spendToken=${build.spendToken || 'unknown'}`);
                if (this.config.gasLimit) {
                    txRequest.gasLimit = this.config.gasLimit;
                } else if (!txRequest.gasLimit) {
                    txRequest.gasLimit = await wallet.estimateGas(Object.assign({}, txRequest));
                    this.logger.info(`[gas-estimate] wallet=${wallet.address} gasLimit=${txRequest.gasLimit.toString()}`);
                }
                if (this.config.simulateBeforeSend) {
                    const simStart = Date.now();
                    try {
                        const simulationTx = Object.assign({}, txRequest);
                        if (simulationTx.gasPrice) {
                            delete simulationTx.gasPrice;
                        }
                        if (simulationTx.maxFeePerGas) {
                            delete simulationTx.maxFeePerGas;
                        }
                        if (simulationTx.maxPriorityFeePerGas) {
                            delete simulationTx.maxPriorityFeePerGas;
                        }
                        if (simulationTx.nonce) {
                            delete simulationTx.nonce;
                        }
                        await wallet.call(simulationTx);
                        const simElapsed = Date.now() - simStart;
                        this.logger.info(`[simulate] wallet=${wallet.address} 协议=${parseModel.protocol}/${parseModel.method} 耗时=${simElapsed}ms`);
                    } catch (simErr) {
                        results.push({
                            wallet: wallet.address,
                            protocol: parseModel.protocol,
                            method: parseModel.method,
                            action: parseModel.action,
                            status: 'failed',
                            error: `simulation failed: ${simErr.message || simErr}`
                        });
                        continue;
                    }
                }
                if (this.config.dryRun) {
                    results.push({
                        wallet: wallet.address,
                        protocol: parseModel.protocol,
                        method: parseModel.method,
                        action: parseModel.action,
                        status: 'simulated',
                        spendToken: build.spendToken ? normalizeAddress(build.spendToken) : ethers.constants.AddressZero,
                        spendAmount: build.spendAmount ? build.spendAmount.toString() : null,
                        expectedMinReceive: build.minReceive ? build.minReceive.toString() : null,
                        message: 'dry-run 模式，仅执行模拟'
                    });
                    continue;
                }
                const canBundle = this.bundleConfig.enabled && !this.config.dryRun && targetPendingTx && !bundleSetupError;
                if (canBundle) {
                    const bundleStart = Date.now();
                    const bundleOutcome = await this.executeBundle({
                        wallet,
                        txRequest,
                        targetRaw
                    });
                    const bundleElapsed = Date.now() - bundleStart;
                    if (bundleOutcome.success) {
                        this.logger.info(`[bundle] wallet=${wallet.address} 成功 tx=${bundleOutcome.txHash} 耗时=${bundleElapsed}ms`);
                    } else {
                        this.logger.warn(`[bundle] wallet=${wallet.address} 失败: ${bundleOutcome.error || 'unknown'} 耗时=${bundleElapsed}ms`);
                    }
                    if (bundleOutcome.success) {
                        results.push({
                            wallet: wallet.address,
                            protocol: parseModel.protocol,
                            method: parseModel.method,
                            action: parseModel.action,
                            status: 'submitted',
                            txHash: bundleOutcome.txHash,
                            spendToken: build.spendToken ? normalizeAddress(build.spendToken) : ethers.constants.AddressZero,
                            spendAmount: build.spendAmount ? build.spendAmount.toString() : null,
                            expectedMinReceive: build.minReceive ? build.minReceive.toString() : null,
                            bundle: true,
                            builders: bundleOutcome.builders || []
                        });
                    } else {
                        results.push({
                            wallet: wallet.address,
                            protocol: parseModel.protocol,
                            method: parseModel.method,
                            action: parseModel.action,
                            status: 'failed',
                            error: bundleOutcome.error || 'bundle failed',
                            bundle: true
                        });
                    }
                    continue;
                }

                const sendStart = Date.now();
                const response = await wallet.sendTransaction(txRequest);
                const sendElapsed = Date.now() - sendStart;
                this.logger.info(`[send] wallet=${wallet.address} tx=${response.hash} 耗时=${sendElapsed}ms`);
                results.push({
                    wallet: wallet.address,
                    protocol: parseModel.protocol,
                    method: parseModel.method,
                    action: parseModel.action,
                    status: 'submitted',
                    txHash: response.hash,
                    spendToken: build.spendToken ? normalizeAddress(build.spendToken) : ethers.constants.AddressZero,
                    spendAmount: build.spendAmount ? build.spendAmount.toString() : null,
                    expectedMinReceive: build.minReceive ? build.minReceive.toString() : null
                });
            } catch (err) {
                results.push({
                    wallet: wallet.address,
                    protocol: parseModel.protocol,
                    method: parseModel.method,
                    action: parseModel.action,
                    status: 'failed',
                    error: err.message || String(err)
                });
            }
            const walletElapsed = Date.now() - startWallet;
            this.logger.info(`[wallet-done] wallet=${wallet.address} 总耗时=${walletElapsed}ms`);
        }
        const totalElapsed = Date.now() - startAll;
        this.logger.info(`[execute-done] 协议=${parseModel.protocol}/${parseModel.method} 钱包数=${this.wallets.length} 总耗时=${totalElapsed}ms`);
        return results;
    }
}

module.exports = {
    SwapBuyer
};
