const { ethers } = require('ethers');
const {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    applySlippage,
    getDeadline
} = require('../helpers');

class FourMemeStrategy {
    constructor() {
        this.abiCoder = new ethers.utils.AbiCoder();
    }

    supports(parseModel) {
        return parseModel.protocol === 'fourmeme_router' && parseModel.method === 'buyToken';
    }

    async buildTx(parseModel, context) {
        const parserResult = parseModel.raw?.parserResult || {};
        const routerAddress = normalizeAddress(parserResult.router);
        if (!routerAddress) {
            throw new Error('FourMemeStrategy 缺少 router 地址');
        }
        const routeId = toBigNumber(parserResult.routeId || 0);
        const tokenOut = normalizeSwapTokenAddress(parserResult.tokenOut || parseModel.amounts?.receive?.token?.address);
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('FourMemeStrategy 缺少 amountIn');
        }
        let minOutBase = toBigNumber(parseModel.amountOutMin || parserResult.amountOutMin || parseModel.amounts?.receive?.amountRaw);
        if (minOutBase && overrideAmount && baseAmountIn && !baseAmountIn.isZero()) {
            minOutBase = minOutBase.mul(overrideAmount).div(baseAmountIn);
        }
        const minOut = minOutBase ? applySlippage(minOutBase, context.config.slippageBps) : null;
        // todo 不管最小输出是多少
        // if (!minOut || minOut.isZero()) {
        //     throw new Error('FourMemeStrategy 缺少最小获得量');
        // }
        const params = this.abiCoder.encode(
            ['uint256', 'address', 'uint256', 'uint256'],
            [routeId || ethers.constants.Zero, tokenOut, amountIn, minOut]
        );
        const data = '0xedf9e251' + params.slice(2);
        const tx = {
            to: routerAddress,
            data,
            value: amountIn
        };
        return {
            tx,
            spendToken: ethers.constants.AddressZero,
            spendAmount: amountIn,
            minReceive: minOut
        };
    }
}

module.exports = FourMemeStrategy;
