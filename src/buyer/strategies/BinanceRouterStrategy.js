const {ethers} = require('ethers');
const {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    ensureAllowance,
    applySlippage
} = require('../helpers');

const PancakeV2Strategy = require('./PancakeV2Strategy');
const PancakeV3Strategy = require('./PancakeV3Strategy');

const BINANCE_ROUTER_ABI = [
    'function swap(address executor,address swapHandler,address srcToken,uint256 amount,address dstToken,uint256 minReturn,bytes data) payable returns (uint256)'
];

class BinanceRouterStrategy {
    constructor() {
        this.interface = new ethers.utils.Interface(BINANCE_ROUTER_ABI);
        this.v2Strategy = new PancakeV2Strategy();
        this.v3Strategy = new PancakeV3Strategy();
        this.routerMap = {
            pancake_v2: process.env.PCS_V2_ROUTER,
            uniswap_v2: process.env.UNI_V2_ROUTER,
            pancake_v3: process.env.PCS_V3_ROUTER,
            uniswap_v3: process.env.UNI_V3_ROUTER
        };
    }

    supports(parseModel) {
        return parseModel.protocol === 'binance_dex_router';
    }


    async buildTx(parseModel, context) {
        const parserResult = parseModel.raw?.parserResult || {};
        const routerAddress = normalizeAddress(parserResult.router);
        if (!routerAddress) {
            throw new Error('Binance Router 缺少 router 地址');
        }
        const executor = normalizeAddress(parserResult.executor);
        const swapHandler = normalizeAddress(parserResult.swapHandler);
        const tokenIn = normalizeSwapTokenAddress(parserResult.tokenIn || parseModel.amounts?.spend?.token?.address);
        const tokenOut = normalizeSwapTokenAddress(parserResult.tokenOut || parseModel.amounts?.receive?.token?.address);
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('Binance Router 缺少 amountIn');
        }
        let baseMinOut = toBigNumber(parseModel.amountOutMin || parserResult.amountOutMin || parseModel.amounts?.receive?.amountRaw);

        if (parserResult.finalHop) {
            try {
                const rebuilt = await this.buildViaFinalHop(parseModel, context, parserResult, parserResult.finalHop, amountIn, baseAmountIn, baseMinOut);
                if (rebuilt) {
                    return rebuilt;
                }
            } catch (err) {
                // ignore and skip below
            }
        }

        return {
            skip: true,
            reason: '未识别 Binance Router 最终池，跳过'
        };
    }

    async buildViaFinalHop(parseModel, context, parserResult, finalHop, overrideAmount, baseAmountIn, baseMinOut) {
        if (!finalHop) {
            return null;
        }
        const dexType = (finalHop.dexType || '').toLowerCase();
        const amountIn = overrideAmount;
        if (!amountIn || amountIn.isZero()) {
            return null;
        }
        const scaledMinBase = this.scaleAmountOutMin(baseMinOut, amountIn, baseAmountIn);
        const needsZeroMin = !scaledMinBase || scaledMinBase.isZero();

        if (['pancake_v2', 'uniswap_v2'].includes(dexType)) {
            const routerAddress = this.resolveRouterAddress(dexType);
            if (!routerAddress) {
                return null;
            }
            const path = Array.isArray(finalHop.path) && finalHop.path.length >= 2 ? finalHop.path : [finalHop.tokenIn, finalHop.tokenOut];
            const spendToken = finalHop.usesNativeInput ? ethers.constants.AddressZero : finalHop.tokenIn;
            const method = finalHop.usesNativeInput ? 'swapExactETHForTokens' : 'swapExactTokensForTokens';
            const recipient = context.wallet.address;

            const parserPayload = {
                router: routerAddress,
                path,
                method,
                amountIn,
                amountOutMin: scaledMinBase || ethers.constants.Zero,
                recipient
            };
            const subModel = {
                protocol: dexType,
                method,
                amountIn,
                amountOutMin: scaledMinBase || ethers.constants.Zero,
                raw: {parserResult: parserPayload},
                amounts: {
                    spend: {
                        amountRaw: amountIn,
                        token: {address: spendToken}
                    },
                    receive: {
                        amountRaw: scaledMinBase || ethers.constants.Zero,
                        token: {address: finalHop.tokenOut}
                    }
                },
                tokens: {
                    spend: {address: spendToken},
                    receive: {address: finalHop.tokenOut}
                }
            };
            const subContext = Object.assign({}, context, {
                overrideAmountIn: amountIn,
                config: Object.assign({}, context.config, {
                    forceZeroMinOut: context.config.forceZeroMinOut || needsZeroMin
                })
            });
            return this.v2Strategy.buildTx(subModel, subContext);
        }

        if (['pancake_v3', 'uniswap_v3'].includes(dexType)) {
            const routerAddress = this.resolveRouterAddress(dexType);
            if (!routerAddress) {
                return null;
            }
            const spendToken = finalHop.usesNativeInput ? ethers.constants.AddressZero : finalHop.tokenIn;
            const parserPayload = {
                router: routerAddress,
                method: 'exactInputSingle',
                tokenIn: finalHop.tokenIn,
                tokenOut: finalHop.tokenOut,
                fee: finalHop.fee,
                amountIn,
                amountOutMin: scaledMinBase || ethers.constants.Zero,
                rawArgs: {
                    tokenIn: finalHop.tokenIn,
                    tokenOut: finalHop.tokenOut,
                    fee: finalHop.fee,
                    amountIn,
                    amountOutMinimum: scaledMinBase || ethers.constants.Zero,
                    sqrtPriceLimitX96: 0
                }
            };
            const subModel = {
                protocol: dexType,
                method: 'exactInputSingle',
                amountIn,
                amountOutMin: scaledMinBase || ethers.constants.Zero,
                raw: {parserResult: parserPayload},
                amounts: {
                    spend: {
                        amountRaw: amountIn,
                        token: {address: spendToken}
                    },
                    receive: {
                        amountRaw: scaledMinBase || ethers.constants.Zero,
                        token: {address: finalHop.tokenOut}
                    }
                },
                tokens: {
                    spend: {address: spendToken},
                    receive: {address: finalHop.tokenOut}
                }
            };
            const subContext = Object.assign({}, context, {
                overrideAmountIn: amountIn,
                config: Object.assign({}, context.config, {
                    forceZeroMinOut: context.config.forceZeroMinOut || needsZeroMin
                })
            });
            return this.v3Strategy.buildTx(subModel, subContext);
        }

        return null;
    }

    scaleAmountOutMin(baseMinOut, overrideAmount, baseAmountIn) {
        const min = toBigNumber(baseMinOut);
        if (!min) {
            return null;
        }
        if (!baseAmountIn || baseAmountIn.isZero()) {
            return min;
        }
        try {
            return min.mul(overrideAmount).div(baseAmountIn);
        } catch (err) {
            return min;
        }
    }

    resolveRouterAddress(dexType) {
        const key = dexType ? dexType.toLowerCase() : '';
        const addr = this.routerMap?.[key];
        if (!addr) {
            return null;
        }
        try {
            return ethers.utils.getAddress(addr);
        } catch (err) {
            return null;
        }
    }

    rebuildPayload(rawPayload, amountIn, minOut) {
        let payload = rawPayload.startsWith('0x') ? rawPayload.slice(2) : rawPayload;
        if (payload.length < 64 * 6) {
            throw new Error('Binance Router payload 长度不足');
        }
        const replaceWord = (hex, wordIndex, value) => {
            const start = wordIndex * 64;
            const end = start + 64;
            if (end > hex.length) {
                throw new Error('Binance Router payload 索引越界');
            }
            const padded = ethers.utils.hexZeroPad(value.toHexString(), 32).slice(2);
            return `${hex.slice(0, start)}${padded}${hex.slice(end)}`;
        };
        let updated = replaceWord(payload, 3, amountIn);
        updated = replaceWord(updated, 5, minOut);
        return updated;
    }
}

module.exports = BinanceRouterStrategy;
