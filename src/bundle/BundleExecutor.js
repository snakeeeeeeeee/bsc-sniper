const { ethers } = require('ethers');
const path = require('path');

const TARGET_ABI = require(path.resolve(__dirname, '../../abi/abi.json'));

class BundleExecutor {
    constructor({ httpProvider }) {
        if (!httpProvider) {
            throw new Error('BundleExecutor 需要 httpProvider');
        }
        this.httpProvider = httpProvider;
        const wssUrl = process.env.BSC_WSS_URL;
        if (!wssUrl) {
            throw new Error('缺少 BSC_WSS_URL');
        }
        this.wsProvider = new ethers.providers.WebSocketProvider(wssUrl);

        const targetAddress = process.env.TARGET_CONTRACT_ADDRESS;
        if (!targetAddress) {
            throw new Error('缺少 TARGET_CONTRACT_ADDRESS');
        }
        this.targetAddress = ethers.utils.getAddress(targetAddress);
        this.contractInterface = new ethers.utils.Interface(TARGET_ABI);
        this.contract = new ethers.Contract(this.targetAddress, TARGET_ABI, this.httpProvider);

        this.bundleTipWei = ethers.constants.Zero;
        if (process.env.BUNDLE_BUILDER_TIP_BNB) {
            try {
                this.bundleTipWei = ethers.utils.parseEther(process.env.BUNDLE_BUILDER_TIP_BNB);
            } catch (err) {
                console.warn('解析 BUNDLE_BUILDER_TIP_BNB 失败，将忽略小费:', err.message);
                this.bundleTipWei = ethers.constants.Zero;
            }
        }
        this.gasLimitOverride = process.env.GAS_LIMIT ? ethers.BigNumber.from(process.env.GAS_LIMIT) : null;
        this.bundleBlocksAhead = Number.isFinite(Number(process.env.BUNDLE_BLOCKS_AHEAD))
            ? Number(process.env.BUNDLE_BLOCKS_AHEAD)
            : 0;

        const builderConfigs = [];
        const blockzeroRpc = process.env.PUISSANT_BUILDER_RPC || 'https://rpc.blockrazor.builders/';
        const blockzeroTip = process.env.PUISSANT_BUILDER_ADDRESS || "0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20";
        if (blockzeroRpc) {
            builderConfigs.push({
                name: 'blockzero',
                rpc: blockzeroRpc,
                tipAddress: blockzeroTip
            });
        }

        const bundle48Rpc = process.env.BUNDLE48_RPC_URL || 'https://puissant-builder.48.club';
        const bundle48Tip = process.env.BUNDLE48_BUILDER_ADDRESS || '0x4848489f0b2BEdd788c696e2D79b6b69D7484848';
        const bundle48SpSign = process.env.BUNDLE48_SP_SIGNATURE || '';
        if (bundle48Rpc) {
            builderConfigs.push({
                name: 'bnb48',
                rpc: bundle48Rpc,
                tipAddress: bundle48Tip,
                spSignature: bundle48SpSign
            });
        }

        this.bundleProviders = builderConfigs.map(cfg => {
            let tipAddress = null;
            if (cfg.tipAddress) {
                try {
                    tipAddress = ethers.utils.getAddress(cfg.tipAddress);
                } catch (err) {
                    console.warn(`${cfg.name} tip 地址无效，将忽略小费:`, err.message);
                }
            }
            return {
                name: cfg.name,
                provider: new ethers.providers.JsonRpcProvider(cfg.rpc),
                tipAddress,
                spSignature: cfg.spSignature || ''
            };
        });

        if (this.bundleProviders.length === 0) {
            throw new Error('未配置任何 bundle RPC 端点');
        }

        this.expectedAmountMap = new Map();
        this.buyRawTxMap = new Map();
    }

    primeExpectedAmount(txHash, amountOut) {
        if (!txHash || !amountOut) return;
        try {
            this.expectedAmountMap.set(txHash.toLowerCase(), ethers.BigNumber.from(amountOut));
        } catch (err) {
            console.warn('primeExpectedAmount 失败:', err.message);
        }
    }

    consumeExpectedAmount(txHash) {
        if (!txHash) return null;
        const key = txHash.toLowerCase();
        if (!this.expectedAmountMap.has(key)) return null;
        const value = this.expectedAmountMap.get(key);
        this.expectedAmountMap.delete(key);
        return value;
    }

    primeBuyRawTx(txHash, rawTx) {
        if (!txHash || !rawTx) return;
        this.buyRawTxMap.set(txHash.toLowerCase(), rawTx);
    }

    consumeBuyRawTx(txHash) {
        if (!txHash) return null;
        const key = txHash.toLowerCase();
        if (!this.buyRawTxMap.has(key)) return null;
        const raw = this.buyRawTxMap.get(key);
        this.buyRawTxMap.delete(key);
        return raw;
    }

    parseBuyTx(pendingTx) {
        if (!pendingTx || !pendingTx.to) return null;
        if (pendingTx.to.toLowerCase() !== this.targetAddress.toLowerCase()) {
            return null;
        }
        try {
            const parsed = this.contractInterface.parseTransaction({
                data: pendingTx.input,
                value: pendingTx.value || '0x0'
            });
            if (parsed.name !== 'buyWithBNB') {
                return null;
            }
            const [tokenOut, fee, amountOutMinimum, sqrtPriceLimitX96] = parsed.args;
            return {
                tokenOut: ethers.utils.getAddress(tokenOut),
                fee: Number(fee),
                amountOutMinimum: ethers.BigNumber.from(amountOutMinimum),
                sqrtPriceLimitX96: ethers.BigNumber.from(sqrtPriceLimitX96),
                value: ethers.BigNumber.from(pendingTx.value || '0x0'),
                parsed
            };
        } catch (err) {
            console.warn('解析 buyWithBNB 失败:', err.message);
            return null;
        }
    }

    async buildSellPlan(pendingTx, buyInfo) {
        if (!buyInfo) {
            buyInfo = this.parseBuyTx(pendingTx);
            if (!buyInfo) {
                return null;
            }
        }

        const { tokenOut, fee, amountOutMinimum, sqrtPriceLimitX96, value } = buyInfo;
        let amountOut = this.consumeExpectedAmount(pendingTx.hash);
        if (!amountOut) {
            try {
                amountOut = await this.contract.callStatic.buyWithBNB(
                    tokenOut,
                    fee,
                    amountOutMinimum,
                    sqrtPriceLimitX96,
                    {
                        from: pendingTx.from,
                        value
                    }
                );
            } catch (err) {
                console.warn('callStatic.buyWithBNB 失败，使用 amountOutMinimum:', err.message);
                amountOut = amountOutMinimum;
            }
        }

        if (!amountOut || amountOut.isZero()) {
            console.warn('未获得有效的 amountOut，放弃构建卖出计划');
            return null;
        }

        const tokenContract = new ethers.Contract(
            tokenOut,
            [
                'function allowance(address owner, address spender) view returns (uint256)',
                'function approve(address spender, uint256 amount) returns (bool)'
            ],
            this.httpProvider
        );

        let allowance = ethers.constants.Zero;
        try {
            allowance = await tokenContract.allowance(pendingTx.from, this.targetAddress);
        } catch (err) {
            console.warn('读取 allowance 失败，默认 0:', err.message);
        }

        const needsApprove = allowance.lt(amountOut);
        const approveInterface = new ethers.utils.Interface([
            'function approve(address spender, uint256 amount) returns (bool)'
        ]);
        const approveTxRequest = needsApprove
            ? {
                to: tokenOut,
                data: approveInterface.encodeFunctionData('approve', [this.targetAddress, ethers.constants.MaxUint256]),
                value: ethers.constants.Zero
            }
            : null;

        const sellCalldata = this.contractInterface.encodeFunctionData('sellForBNB', [
            tokenOut,
            amountOut,
            fee,
            ethers.constants.Zero,
            ethers.constants.Zero
        ]);

        return {
            approveTxRequest,
            txRequest: {
                to: this.targetAddress,
                data: sellCalldata,
                value: ethers.constants.Zero
            }
        };
    }

    async bundleSignedBuyTx(signedBuyTx, wallet, options = {}) {
        if (!signedBuyTx) {
            throw new Error('缺少签名买单原始交易');
        }
        if (!wallet) {
            throw new Error('缺少钱包实例');
        }

        const parsedTx = ethers.utils.parseTransaction(signedBuyTx);
        if (!parsedTx || !parsedTx.from) {
            throw new Error('无法解析签名买单');
        }

        const pendingTx = {
            hash: ethers.utils.keccak256(signedBuyTx),
            from: parsedTx.from,
            to: parsedTx.to,
            input: parsedTx.data,
            value: parsedTx.value ? parsedTx.value.toHexString() : '0x0',
            nonce: parsedTx.nonce,
            gasPrice: parsedTx.gasPrice ? parsedTx.gasPrice.toHexString() : undefined,
            maxFeePerGas: parsedTx.maxFeePerGas ? parsedTx.maxFeePerGas.toHexString() : undefined,
            maxPriorityFeePerGas: parsedTx.maxPriorityFeePerGas ? parsedTx.maxPriorityFeePerGas.toHexString() : undefined,
            gas: parsedTx.gasLimit ? parsedTx.gasLimit.toHexString() : undefined
        };

        const sellPlan = await this.buildSellPlan(pendingTx);
        if (!sellPlan) {
            throw new Error('无法构建卖出计划');
        }

        const gasPrice = parsedTx.gasPrice ? ethers.BigNumber.from(parsedTx.gasPrice) : await this.httpProvider.getGasPrice();
        const gasLimit = this.gasLimitOverride || ethers.BigNumber.from('400000');

        let currentNonce = await this.httpProvider.getTransactionCount(wallet.address, 'pending');
        if (pendingTx.from && wallet.address.toLowerCase() === pendingTx.from.toLowerCase()) {
            const candidate = parsedTx.nonce + 1;
            if (candidate > currentNonce) {
                currentNonce = candidate;
            }
        }

        const txBuilds = [];
        if (sellPlan.approveTxRequest) {
            txBuilds.push({
                type: 'approve',
                unsigned: {
                    to: sellPlan.approveTxRequest.to,
                    data: sellPlan.approveTxRequest.data,
                    value: ethers.constants.Zero,
                    gasPrice,
                    gasLimit: ethers.BigNumber.from('80000'),
                    nonce: currentNonce
                }
            });
            currentNonce += 1;
        }

        txBuilds.push({
            type: 'sell',
            unsigned: {
                to: sellPlan.txRequest.to,
                data: sellPlan.txRequest.data,
                value: sellPlan.txRequest.value || ethers.constants.Zero,
                gasPrice,
                gasLimit,
                nonce: currentNonce
            }
        });
        currentNonce += 1;

        const baseSignedTxs = [];
        for (const entry of txBuilds) {
            const signed = await wallet.signTransaction(entry.unsigned);
            baseSignedTxs.push(signed);
        }
        const sellTxHash = ethers.utils.keccak256(baseSignedTxs[baseSignedTxs.length - 1]);

        const buyRawTx = this.consumeBuyRawTx(pendingTx.hash);
        if (!buyRawTx) {
            throw new Error('未找到对应买单原始交易');
        }

        const bundlePlans = [];
        for (const builder of this.bundleProviders) {
            const planTxs = [...baseSignedTxs];
            if (!this.bundleTipWei.isZero() && builder.tipAddress) {
                const tipUnsignedTx = {
                    to: builder.tipAddress,
                    data: '0x',
                    value: this.bundleTipWei,
                    gasPrice,
                    gasLimit: ethers.BigNumber.from('21000'),
                    nonce: currentNonce
                };
                const tipSigned = await wallet.signTransaction(tipUnsignedTx);
                planTxs.push(tipSigned);
            }
            bundlePlans.push({
                builder,
                signedTxs: planTxs
            });
        }

        await this.sendBundleToAllProviders(bundlePlans, pendingTx, buyRawTx, sellTxHash, options.quiet);
        return {
            bundleSucceeded: true
        };
    }

    async sendBundleToAllProviders(bundlePlans, pendingTx, buyRawTx, sellTxHash, quiet = false) {
        const plansWithBuy = bundlePlans.map(plan => ({
            ...plan,
            txs: [buyRawTx, ...plan.signedTxs]
        }));

        const sendAttempt = async () => Promise.allSettled(
            plansWithBuy.map(plan => this.sendBundleViaProvider(plan, sellTxHash, quiet))
        );

        let results = await sendAttempt();
        if (results.some(res => res.status === 'fulfilled' && res.value === true)) {
            return true;
        }

        const targetBlock = plansWithBuy.length > 0 ? plansWithBuy[0].targetBlockNumber : 'N/A';
        if (!quiet) {
            console.warn(`[bundle-executor] 所有节点均失败（目标区块 ${targetBlock}），尝试重发一次...`);
        }

        results = await sendAttempt();
        if (results.some(res => res.status === 'fulfilled' && res.value === true)) {
            return true;
        }

        const errorMsgs = results
            .map((res, idx) => ({ res, idx }))
            .filter(item => item.res.status === 'rejected')
            .map(item => {
                const builderName = plansWithBuy[item.idx].builder.name;
                const reason = item.res.reason;
                const msg = reason && reason.message ? reason.message : `${reason}`;
                if (/eth_sendBundle/.test(msg)) {
                    return `[${builderName}] 节点未开放 eth_sendBundle`;
                }
                return `[${builderName}] ${msg}`;
            });

        throw new Error(errorMsgs.join('; ') || '所有 bundle 节点均返回失败');
    }

    async sendBundleViaProvider(plan, sellTxHash, quiet = false) {
        const { builder, txs } = plan;
        const log = (...args) => {
            if (!quiet) {
                console.log(...args);
            }
        };
        try {
            log(`${new Date().toISOString()} - \n===== ${builder.name} 发送交易捆绑 =====`);
            const currentBlock = await this.wsProvider.getBlockNumber();
            log(`[${builder.name}] 当前区块: ${currentBlock}`);
            const blocksAhead = Number.isFinite(this.bundleBlocksAhead) ? Math.max(0, this.bundleBlocksAhead) : 0;
            const targetBlockNumber = currentBlock + blocksAhead;
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const maxTimestamp = currentTimestamp + 60;
            const bundleParams = {
                txs,
                targetBlockNumber,
                maxBlockNumber: Math.min(targetBlockNumber + 50, currentBlock + 100),
                maxTimestamp
            };

            if (builder.spSignature) {
                bundleParams['48spSign'] = builder.spSignature;
            }

            log(`[${builder.name}] 目标区块: ${targetBlockNumber}`);
            const response = await builder.provider.send('eth_sendBundle', [bundleParams]);
            log(`[${builder.name}] ✅ 捆绑交易请求已提交成功! 响应: ${JSON.stringify(response, null, 2)}`);

            const timeoutMs = 3000;
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                const receipt = await this.wsProvider.getTransactionReceipt(sellTxHash);
                if (receipt) {
                    log(`[${builder.name}] ✅ 捆绑卖出交易上链! 区块号: ${receipt.blockNumber}`);
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            throw new Error(`捆绑交易在 ${timeoutMs / 1000}s 内未上链`);
        } catch (error) {
            console.error(`[${builder.name}] 发送捆绑交易失败:`, error.message);
            throw error;
        }
    }

    async shutdown() {
        try {
            if (this.wsProvider && this.wsProvider._websocket) {
                this.wsProvider._websocket.terminate();
            }
        } catch (err) {
            console.warn('关闭 BundleExecutor wsProvider 失败:', err.message);
        }
    }
}

module.exports = {
    BundleExecutor
};
