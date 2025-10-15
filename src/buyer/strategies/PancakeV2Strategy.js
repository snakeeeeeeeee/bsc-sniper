const { ethers } = require('ethers');
const {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    ensureAllowance,
    applySlippage,
    getDeadline
} = require('../helpers');

const PCS_V2_ROUTER_ABI = [
    'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)'
];

class PancakeV2Strategy {
    constructor() {
        this.interface = new ethers.utils.Interface(PCS_V2_ROUTER_ABI);
    }

    supports(parseModel) {
        const protocol = (parseModel.protocol || '').toLowerCase();
        return protocol === 'pancake_v2' || protocol === 'uniswap_v2';
    }

    async buildTx(parseModel, context) {
        const { raw } = parseModel;
        const parserResult = raw?.parserResult || {};
        const path = parserResult.path;
        if (!Array.isArray(path) || path.length < 2) {
            throw new Error('Pancake v2 缺少路径信息');
        }
        const routerAddress = normalizeAddress(parserResult.router);
        if (!routerAddress) {
            throw new Error('Pancake v2 缺少 router 地址');
        }
        const methodName = (parserResult.method || parseModel.method || '').toLowerCase();
        const isNativeTrade = methodName.startsWith('swapexacteth');
        const spendTokenRaw = normalizeSwapTokenAddress(parseModel.amounts?.spend?.token?.address);
        const spendToken = isNativeTrade ? ethers.constants.AddressZero : spendTokenRaw;
        const baseAmountIn = toBigNumber(parseModel.amountIn || parserResult.amountIn);
        const overrideAmount = context.overrideAmountIn || null;
        const amountIn = overrideAmount || baseAmountIn;
        if (!amountIn || amountIn.isZero()) {
            throw new Error('Pancake v2 缺少 amountIn');
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
            throw new Error('Pancake v2 缺少 amountOutMin');
        }
        const deadline = getDeadline(context.config.deadlineSeconds);
        const recipient = normalizeAddress(parserResult.recipient) || context.wallet.address;

        const populated = spendToken === ethers.constants.AddressZero
            ? this.interface.encodeFunctionData('swapExactETHForTokens', [minOut, path, recipient, deadline])
            : this.interface.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, path, recipient, deadline]);

        const tx = {
            to: routerAddress,
            data: populated,
            value: spendToken === ethers.constants.AddressZero ? amountIn : ethers.constants.Zero
        };

        if (spendToken !== ethers.constants.AddressZero) {
            await ensureAllowance(spendToken, context.wallet, routerAddress, amountIn, context.config.approvalOptions || {});
        }

        return {
            tx,
            spendToken,
            spendAmount: amountIn,
            minReceive: minOut
        };
    }
}

module.exports = PancakeV2Strategy;
