const { ethers } = require('ethers');
const {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    ensureAllowance,
    applySlippage,
    getDeadline
} = require('../helpers');

const PCS_V3_ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
    'function exactInput(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) payable returns (uint256 amountOut)'
];

class PancakeV3Strategy {
    constructor() {
        this.interface = new ethers.utils.Interface(PCS_V3_ROUTER_ABI);
    }

    supports(parseModel) {
        const protocol = (parseModel.protocol || '').toLowerCase();
        return protocol === 'pancake_v3' || protocol === 'uniswap_v3';
    }

    async buildTx(parseModel, context) {
        const parserResult = parseModel.raw?.parserResult || {};
        const routerAddress = normalizeAddress(parserResult.router);
        if (!routerAddress) {
            throw new Error('Pancake v3 缺少 router 地址');
        }
        const method = parserResult.method;
        const spendToken = normalizeSwapTokenAddress(parseModel.amounts?.spend?.token?.address || parserResult.tokenIn);
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('Pancake v3 缺少 amountIn');
        }
        let minOutBase = toBigNumber(parseModel.amountOutMin || parserResult.amountOutMin || parseModel.amounts?.receive?.amountRaw);
        if (minOutBase && overrideAmount && baseAmountIn && !baseAmountIn.isZero()) {
            minOutBase = minOutBase.mul(overrideAmount).div(baseAmountIn);
        }
        const minOut = minOutBase ? applySlippage(minOutBase, context.config.slippageBps) : null;
        if (!minOut || minOut.isZero()) {
            throw new Error('Pancake v3 缺少 amountOutMin');
        }
        const recipient = context.wallet.address;
        const deadline = getDeadline(context.config.deadlineSeconds);

        let data;
        let value = ethers.constants.Zero;
        if (method === 'exactInputSingle') {
            const params = {
                tokenIn: normalizeSwapTokenAddress(parserResult.tokenIn),
                tokenOut: normalizeSwapTokenAddress(parserResult.tokenOut),
                fee: parserResult.fee,
                recipient,
                deadline,
                amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: parserResult.rawArgs?.sqrtPriceLimitX96 || 0
            };
            data = this.interface.encodeFunctionData('exactInputSingle', [params]);
        } else if (method === 'exactInput') {
            const rawArgs = parserResult.rawArgs || {};
            if (!rawArgs.path) {
                throw new Error('Pancake v3 exactInput 缺少 path');
            }
            data = this.interface.encodeFunctionData('exactInput', [rawArgs.path, recipient, amountIn, minOut]);
        } else {
            throw new Error(`Pancake v3 不支持的方法: ${method}`);
        }

        if (spendToken === ethers.constants.AddressZero) {
            value = amountIn;
        }

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
}

module.exports = PancakeV3Strategy;
