const { ethers } = require('ethers');
const {
    normalizeAddress,
    buildTradeSummary,
    toBigNumber
} = require('./utils');

const PCS_V2_ROUTER_ABI = [
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
    'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)'
];

const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) view returns (address pair)'
];

class PancakeV2Parser {
    constructor({ provider, routerAddress, factoryAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('PancakeV2Parser 需要 provider');
        }
        if (!routerAddress) {
            throw new Error('PancakeV2Parser 需要 routerAddress');
        }
        if (!factoryAddress) {
            throw new Error('PancakeV2Parser 需要 factoryAddress');
        }
        if (!wbnbAddress) {
            throw new Error('PancakeV2Parser 需要 wbnbAddress');
        }
        this.provider = provider;
        this.routerAddress = normalizeAddress(routerAddress);
        this.factoryAddress = normalizeAddress(factoryAddress);
        this.wbnbAddress = normalizeAddress(wbnbAddress);
        this.interface = new ethers.utils.Interface(PCS_V2_ROUTER_ABI);
        this.factoryContract = new ethers.Contract(this.factoryAddress, FACTORY_ABI, provider);
        this.lowerRouter = this.routerAddress.toLowerCase();
        this.pairCache = new Map();
    }

    supports(pendingTx) {
        if (!pendingTx || !pendingTx.to) return false;
        return pendingTx.to.toLowerCase() === this.lowerRouter;
    }

    async parse(pendingTx) {
        if (!this.supports(pendingTx)) {
            return null;
        }
        try {
            const parsed = this.interface.parseTransaction({
                data: pendingTx.input,
                value: pendingTx.value || '0x0'
            });
            const path = this.normalizePath(parsed.args.path);
            const pools = await this.derivePools(path);
            const tradeSummary = this.buildTradeSummary(pendingTx, parsed, path);
            return {
                protocol: 'pancake_v2',
                router: this.routerAddress,
                method: parsed.name,
                path,
                pools,
                amountIn: this.extractAmountIn(parsed),
                amountOutMin: this.extractAmountOutMin(parsed),
                recipient: normalizeAddress(parsed.args.to),
                rawArgs: parsed.args,
                tradeSummary
            };
        } catch (err) {
            return null;
        }
    }

    normalizePath(path) {
        if (!Array.isArray(path)) return [];
        return path.map(addr => {
            if (!addr || addr === ethers.constants.AddressZero) {
                return this.wbnbAddress;
            }
            return normalizeAddress(addr);
        }).filter(Boolean);
    }

    async derivePools(path) {
        if (!path || path.length < 2) {
            return [];
        }
        const pools = [];
        for (let i = 0; i < path.length - 1; i += 1) {
            const tokenA = path[i];
            const tokenB = path[i + 1];
            const cacheKey = `${tokenA.toLowerCase()}-${tokenB.toLowerCase()}`;
            if (this.pairCache.has(cacheKey)) {
                pools.push({
                    index: i,
                    tokenIn: tokenA,
                    tokenOut: tokenB,
                    pairAddress: this.pairCache.get(cacheKey)
                });
                continue;
            }
            let pairAddress = ethers.constants.AddressZero;
            try {
                pairAddress = await this.factoryContract.getPair(tokenA, tokenB);
                if (pairAddress && pairAddress !== ethers.constants.AddressZero) {
                    this.pairCache.set(cacheKey, pairAddress);
                }
            } catch (err) {
                console.warn(`读取 Pancake v2 pair 失败: ${err.message}`);
            }
            pools.push({
                index: i,
                tokenIn: tokenA,
                tokenOut: tokenB,
                pairAddress: normalizeAddress(pairAddress) || null
            });
        }
        return pools;
    }

    buildTradeSummary(pendingTx, parsed, path) {
        if (!path || path.length === 0) {
            return null;
        }
        const spendAddress = path[0] || this.wbnbAddress;
        const receiveAddress = path[path.length - 1] || this.wbnbAddress;
        const method = parsed.name;
        const args = parsed.args;
        const valueBn = toBigNumber(pendingTx.value || '0x0');
        let spendAmountBn = null;
        let spendType = 'exact';
        let receiveAmountBn = null;
        let receiveType = 'min';

        switch (method) {
        case 'swapExactETHForTokens':
        case 'swapExactETHForTokensSupportingFeeOnTransferTokens':
            spendAmountBn = valueBn;
            receiveAmountBn = toBigNumber(args.amountOutMin);
            break;
        case 'swapExactTokensForETH':
        case 'swapExactTokensForETHSupportingFeeOnTransferTokens':
        case 'swapExactTokensForTokens':
        case 'swapExactTokensForTokensSupportingFeeOnTransferTokens':
            spendAmountBn = toBigNumber(args.amountIn);
            receiveAmountBn = toBigNumber(args.amountOutMin);
            break;
        case 'swapTokensForExactTokens':
            spendAmountBn = toBigNumber(args.amountInMax);
            spendType = 'max';
            receiveAmountBn = toBigNumber(args.amountOut);
            receiveType = 'exact';
            break;
        case 'swapTokensForExactETH':
            spendAmountBn = toBigNumber(args.amountInMax);
            spendType = 'max';
            receiveAmountBn = toBigNumber(args.amountOut);
            receiveType = 'exact';
            break;
        default:
            spendAmountBn = spendAmountBn || null;
            receiveAmountBn = receiveAmountBn || null;
        }

        if (!spendAmountBn && valueBn && !valueBn.isZero() && (method === 'swapExactETHForTokens' || method === 'swapExactETHForTokensSupportingFeeOnTransferTokens')) {
            spendAmountBn = valueBn;
        }

        if (!spendAmountBn && !receiveAmountBn) {
            return null;
        }

        return buildTradeSummary(
            this.wbnbAddress,
            spendAddress,
            receiveAddress,
            spendAmountBn,
            spendType,
            receiveAmountBn,
            receiveType
        );
    }

    extractAmountIn(parsed) {
        if (!parsed || !parsed.args) return null;
        const { name, args } = parsed;
        switch (name) {
        case 'swapExactETHForTokens':
        case 'swapExactETHForTokensSupportingFeeOnTransferTokens':
            return ethers.BigNumber.from(parsed.value || args.amountIn || ethers.constants.Zero);
        case 'swapExactTokensForTokens':
        case 'swapExactTokensForTokensSupportingFeeOnTransferTokens':
        case 'swapExactTokensForETH':
        case 'swapExactTokensForETHSupportingFeeOnTransferTokens':
            return ethers.BigNumber.from(args.amountIn);
        case 'swapTokensForExactTokens':
        case 'swapTokensForExactETH':
            return ethers.BigNumber.from(args.amountInMax);
        default:
            return null;
        }
    }

    extractAmountOutMin(parsed) {
        if (!parsed || !parsed.args) return null;
        const { name, args } = parsed;
        switch (name) {
        case 'swapExactETHForTokens':
        case 'swapExactETHForTokensSupportingFeeOnTransferTokens':
        case 'swapExactTokensForTokens':
        case 'swapExactTokensForTokensSupportingFeeOnTransferTokens':
        case 'swapExactTokensForETH':
        case 'swapExactTokensForETHSupportingFeeOnTransferTokens':
            return ethers.BigNumber.from(args.amountOutMin);
        case 'swapTokensForExactTokens':
        case 'swapTokensForExactETH':
            return ethers.BigNumber.from(args.amountOut);
        default:
            return null;
        }
    }
}

module.exports = PancakeV2Parser;
