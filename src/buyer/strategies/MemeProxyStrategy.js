const { ethers } = require('ethers');
const {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    ensureAllowance,
    applySlippage,
    getDeadline
} = require('../helpers');

const MEME_PROXY_ABI = [
    'function buyMemeToken(address tokenManager,address token,address recipient,uint256 funds,uint256 minAmount) payable returns (uint256)',
    'function swapV2ExactIn(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address poolAddress) payable returns (uint256)',
    'function swapV3ExactIn(tuple(address factoryAddress,address poolAddress,address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)'
];

class MemeProxyStrategy {
    constructor() {
        this.interface = new ethers.utils.Interface(MEME_PROXY_ABI);
    }

    supports(parseModel) {
        return parseModel.protocol === 'meme_proxy_router';
    }

    async buildTx(parseModel, context) {
        const parserResult = parseModel.raw?.parserResult || {};
        const routerAddress = normalizeAddress(parserResult.router);
        if (!routerAddress) {
            throw new Error('Meme Proxy 缺少 router 地址');
        }
        const method = parserResult.method;
        switch (method) {
        case 'buyMemeToken':
            return this.buildBuyMemeToken(parseModel, parserResult, routerAddress, context);
        case 'swapV2ExactIn':
            return this.buildSwapV2(parseModel, parserResult, routerAddress, context);
        case 'swapV3ExactIn':
            return this.buildSwapV3(parseModel, parserResult, routerAddress, context);
        default:
            throw new Error(`Meme Proxy 不支持的方法: ${method}`);
        }
    }

    async buildBuyMemeToken(parseModel, parserResult, routerAddress, context) {
        const tokenManager = normalizeAddress(parserResult.tokenManager);
        const token = normalizeSwapTokenAddress(parserResult.token);
        const recipient = normalizeAddress(parserResult.recipient) || context.wallet.address;
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.funds || parseModel.amounts?.spend?.amountRaw);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('buyMemeToken 缺少资金数量');
        }
        let minOutBase = toBigNumber(parseModel.amountOutMin || parserResult.minAmount || parseModel.amounts?.receive?.amountRaw);
        if (minOutBase && overrideAmount && baseAmountIn && !baseAmountIn.isZero()) {
            minOutBase = minOutBase.mul(overrideAmount).div(baseAmountIn);
        }
        let minOut = minOutBase ? applySlippage(minOutBase, context.config.slippageBps) : null;
        if (context.config.forceZeroMinOut) {
            minOut = ethers.constants.Zero;
        }
        if (!minOut || (minOut.isZero() && !context.config.forceZeroMinOut)) {
            throw new Error('buyMemeToken 缺少最小获取量');
        }
        const spendToken = normalizeSwapTokenAddress(parseModel.amounts?.spend?.token?.address);
        const value = spendToken === ethers.constants.AddressZero ? amountIn : ethers.constants.Zero;

        const data = this.interface.encodeFunctionData('buyMemeToken', [
            tokenManager,
            token,
            recipient,
            amountIn,
            minOut
        ]);

        if (spendToken !== ethers.constants.AddressZero) {
            await ensureAllowance(spendToken, context.wallet, routerAddress, amountIn, context.config.approvalOptions || {});
        }

        return {
            tx: {
                to: routerAddress,
                data,
                value
            },
            spendToken,
            spendAmount: amountIn,
            minReceive: minOut
        };
    }

    async buildSwapV2(parseModel, parserResult, routerAddress, context) {
        const tokenIn = normalizeSwapTokenAddress(parserResult.tokenIn || parseModel.amounts?.spend?.token?.address);
        const tokenOut = normalizeSwapTokenAddress(parserResult.tokenOut || parseModel.amounts?.receive?.token?.address);
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('swapV2ExactIn 缺少 amountIn');
        }
        let minOutBase = toBigNumber(parseModel.amountOutMin || parserResult.amountOutMin || parseModel.amounts?.receive?.amountRaw);
        if (minOutBase && overrideAmount && baseAmountIn && !baseAmountIn.isZero()) {
            minOutBase = minOutBase.mul(overrideAmount).div(baseAmountIn);
        }
        let minOut = minOutBase ? applySlippage(minOutBase, context.config.slippageBps) : null;
        if (context.config.forceZeroMinOut) {
            minOut = ethers.constants.Zero;
        }
        if (!minOut || (minOut.isZero() && !context.config.forceZeroMinOut)) {
            throw new Error('swapV2ExactIn 缺少 amountOutMin');
        }
        const poolAddress = normalizeAddress(parserResult.poolAddress);
        const data = this.interface.encodeFunctionData('swapV2ExactIn', [
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            poolAddress
        ]);
        const value = tokenIn === ethers.constants.AddressZero ? amountIn : ethers.constants.Zero;
        if (tokenIn !== ethers.constants.AddressZero) {
            await ensureAllowance(tokenIn, context.wallet, routerAddress, amountIn, context.config.approvalOptions || {});
        }
        return {
            tx: {
                to: routerAddress,
                data,
                value
            },
            spendToken: tokenIn,
            spendAmount: amountIn,
            minReceive: minOut
        };
    }

    async buildSwapV3(parseModel, parserResult, routerAddress, context) {
        const params = parserResult.params || {};
        const tokenIn = normalizeSwapTokenAddress(params.tokenIn || parseModel.amounts?.spend?.token?.address);
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn || params.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('swapV3ExactIn 缺少 amountIn');
        }
        let minOutBase = toBigNumber(parseModel.amountOutMin || params.amountOutMinimum || parseModel.amounts?.receive?.amountRaw);
        if (minOutBase && overrideAmount && baseAmountIn && !baseAmountIn.isZero()) {
            minOutBase = minOutBase.mul(overrideAmount).div(baseAmountIn);
        }
        let minOut = minOutBase ? applySlippage(minOutBase, context.config.slippageBps) : null;
        if (context.config.forceZeroMinOut) {
            minOut = ethers.constants.Zero;
        }
        if (!minOut || (minOut.isZero() && !context.config.forceZeroMinOut)) {
            throw new Error('swapV3ExactIn 缺少 amountOutMinimum');
        }
        const deadline = getDeadline(context.config.deadlineSeconds);
        const strategyParams = {
            factoryAddress: normalizeAddress(params.factoryAddress),
            poolAddress: normalizeAddress(params.poolAddress),
            tokenIn,
            tokenOut: normalizeSwapTokenAddress(params.tokenOut || parseModel.amounts?.receive?.token?.address),
            fee: params.fee || 0,
            recipient: context.wallet.address,
            deadline,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96 || 0
        };
        const data = this.interface.encodeFunctionData('swapV3ExactIn', [strategyParams]);
        const value = tokenIn === ethers.constants.AddressZero ? amountIn : ethers.constants.Zero;
        if (tokenIn !== ethers.constants.AddressZero) {
            await ensureAllowance(tokenIn, context.wallet, routerAddress, amountIn, context.config.approvalOptions || {});
        }
        return {
            tx: {
                to: routerAddress,
                data,
                value
            },
            spendToken: tokenIn,
            spendAmount: amountIn,
            minReceive: minOut
        };
    }
}

module.exports = MemeProxyStrategy;
