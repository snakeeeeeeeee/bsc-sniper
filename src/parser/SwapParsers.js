const { ethers } = require('ethers');

const MEME_PROXY_ABI = require('../../abi/FourMeme.json');

const NATIVE_TOKEN_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO_ADDRESS_LOWER = ethers.constants.AddressZero.toLowerCase();
const NATIVE_TOKEN_LOWER = NATIVE_TOKEN_SENTINEL.toLowerCase();

// 常用锚定稳定币映射，便于输出友好的符号
const ANCHOR_TOKEN_SYMBOLS = {
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': { symbol: 'USD1', decimals: 18 }
};

function isNativeLike(lowerAddress) {
    if (!lowerAddress) {
        return false;
    }
    return lowerAddress === ZERO_ADDRESS_LOWER || lowerAddress === NATIVE_TOKEN_LOWER;
}

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

const V3_POOL_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function factory() view returns (address)'
];

const PCS_V3_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
    'function exactInput(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) payable returns (uint256 amountOut)',
    'function exactOutput(bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) payable returns (uint256 amountIn)'
];

const V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

// 0x810c705b / 0xc0ea4b44 均复用相同的参数布局，这里仅区分语义标签方便日志
const BINANCE_DEX_ROUTER_SELECTORS = {
    '0x810c705b': 'swap_native',
    '0xc0ea4b44': 'swap_token'
};

const SMART_SWAP_SELECTORS = new Set([
    '0xb80c2f09'
]);

const FOUR_MEME_ROUTER_ADDRESS = '0x5C952063C7fC8610ffDB798152D69F0B9550762B';

function shortAddress(address) {
    if (!address) return '未知地址';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function resolveTokenMeta(address, wbnbAddress) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
        return null;
    }
    const lower = normalized.toLowerCase();
    if (isNativeLike(lower)) {
        return { address: ethers.constants.AddressZero, symbol: 'BNB', decimals: 18 };
    }
    const wbnbNormalized = normalizeAddress(wbnbAddress);
    if (wbnbNormalized && lower === wbnbNormalized.toLowerCase()) {
        return { address: wbnbNormalized, symbol: 'WBNB', decimals: 18 };
    }
    const anchorMeta = ANCHOR_TOKEN_SYMBOLS[lower];
    if (anchorMeta) {
        return {
            address: normalized,
            symbol: anchorMeta.symbol,
            decimals: anchorMeta.decimals
        };
    }
    return { address: normalized, symbol: null, decimals: 18 };
}

function formatAmount(amountBn, decimals, precision = 6) {
    if (!amountBn) return null;
    const decimalsSafe = Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
    const formatted = ethers.utils.formatUnits(amountBn, decimalsSafe);
    const [intPart, fracPart = ''] = formatted.split('.');
    if (fracPart.length === 0) {
        return intPart;
    }
    const trimmedFrac = fracPart.slice(0, precision).replace(/0+$/, '');
    return trimmedFrac.length > 0 ? `${intPart}.${trimmedFrac}` : intPart;
}

function buildAmountLeg(amountBn, tokenMeta, type = 'exact') {
    if (!amountBn || !tokenMeta) {
        return null;
    }
    const amountFormatted = formatAmount(amountBn, tokenMeta.decimals);
    const symbol = tokenMeta.symbol || shortAddress(tokenMeta.address);
    return {
        amount: amountBn,
        amountFormatted: `${amountFormatted} ${symbol}`,
        type,
        token: tokenMeta
    };
}

function deriveAction(spendMeta, receiveMeta, wbnbAddress) {
    const wbnbNormalized = normalizeAddress(wbnbAddress);
    const wbnbLower = wbnbNormalized ? wbnbNormalized.toLowerCase() : null;
    const spendLower = spendMeta?.address ? spendMeta.address.toLowerCase() : null;
    const receiveLower = receiveMeta?.address ? receiveMeta.address.toLowerCase() : null;
    if (wbnbLower) {
        const spendMatchesBase = spendLower && (spendLower === wbnbLower || isNativeLike(spendLower));
        const receiveMatchesBase = receiveLower && (receiveLower === wbnbLower || isNativeLike(receiveLower));
        if (spendMatchesBase && !receiveMatchesBase) {
            return 'buy';
        }
        if (receiveMatchesBase && !spendMatchesBase) {
            return 'sell';
        }
    }
    return 'swap';
}

function buildTradeSummary(wbnbAddress, spendAddress, receiveAddress, spendAmountBn, spendType = 'exact', receiveAmountBn, receiveType = 'min') {
    if (!spendAmountBn && !receiveAmountBn) {
        return null;
    }
    const spendMeta = spendAddress ? resolveTokenMeta(spendAddress, wbnbAddress) : null;
    const receiveMeta = receiveAddress ? resolveTokenMeta(receiveAddress, wbnbAddress) : null;
    const spend = buildAmountLeg(spendAmountBn, spendMeta, spendType);
    const receive = buildAmountLeg(receiveAmountBn, receiveMeta, receiveType);
    if (!spend && !receive) {
        return null;
    }
    const action = deriveAction(spendMeta, receiveMeta, wbnbAddress);
    return { action, spend, receive };
}

function toBigNumber(value) {
    if (value === undefined || value === null) {
        return null;
    }
    try {
        return ethers.BigNumber.from(value);
    } catch (err) {
        return null;
    }
}

function normalizeAddress(address) {
    if (!address || typeof address !== 'string') {
        return null;
    }
    const trimmed = address.trim();
    if (trimmed.length === 0) {
        return null;
    }
    try {
        return ethers.utils.getAddress(trimmed);
    } catch (err) {
        try {
            return ethers.utils.getAddress(trimmed.toLowerCase());
        } catch (fallbackErr) {
            return null;
        }
    }
}

function normalizeSwapTokenAddress(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
        return null;
    }
    if (isNativeLike(normalized.toLowerCase())) {
        return ethers.constants.AddressZero;
    }
    return normalized;
}

function wordToAddress(word) {
    if (!word || word.length < 40) {
        return null;
    }
    const addrHex = word.slice(-40);
    return normalizeAddress(`0x${addrHex}`);
}

function splitWords(payload) {
    if (!payload || payload.length === 0) {
        return [];
    }
    const cleaned = payload.replace(/\s+/g, '');
    const words = [];
    for (let offset = 0; offset + 64 <= cleaned.length; offset += 64) {
        const chunk = cleaned.slice(offset, offset + 64);
        if (chunk.length === 64) {
            words.push(chunk);
        }
    }
    return words;
}

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
            console.error(err);
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

class PancakeV3Parser {
    constructor({ provider, routerAddress, factoryAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('PancakeV3Parser 需要 provider');
        }
        if (!routerAddress) {
            throw new Error('PancakeV3Parser 需要 routerAddress');
        }
        if (!factoryAddress) {
            throw new Error('PancakeV3Parser 需要 factoryAddress');
        }
        this.provider = provider;
        this.routerAddress = normalizeAddress(routerAddress);
        this.factoryAddress = normalizeAddress(factoryAddress);
        this.wbnbAddress = normalizeAddress(wbnbAddress);
        this.interface = new ethers.utils.Interface(PCS_V3_ROUTER_ABI);
        this.factoryContract = new ethers.Contract(this.factoryAddress, V3_FACTORY_ABI, provider);
        this.lowerRouter = this.routerAddress.toLowerCase();
        this.poolCache = new Map();
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
            if (parsed.name === 'exactInputSingle' || parsed.name === 'exactOutputSingle') {
                return await this.parseSingle(parsed);
            }
            if (parsed.name === 'exactInput' || parsed.name === 'exactOutput') {
                return await this.parsePath(parsed);
            }
            return null;
        } catch (err) {
            return null;
        }
    }

    async parseSingle(parsed) {
        const params = parsed.args[0];
        const tokenIn = this.normalizeToken(params.tokenIn);
        const tokenOut = this.normalizeToken(params.tokenOut);
        const fee = Number(params.fee);
        const pool = await this.getPool(tokenIn, tokenOut, fee);
        const tradeSummary = this.buildTradeSummary(tokenIn, tokenOut, {
            spendAmount: parsed.name === 'exactInputSingle' ? toBigNumber(params.amountIn) : toBigNumber(params.amountInMaximum),
            spendType: parsed.name === 'exactInputSingle' ? 'exact' : 'max',
            receiveAmount: parsed.name === 'exactInputSingle' ? toBigNumber(params.amountOutMinimum) : toBigNumber(params.amountOut),
            receiveType: parsed.name === 'exactInputSingle' ? 'min' : 'exact'
        });
        return {
            protocol: 'pancake_v3',
            router: this.routerAddress,
            method: parsed.name,
            tokenIn,
            tokenOut,
            fee,
            amountIn: this.extractAmountIn(parsed),
            amountOutMin: this.extractAmountOutMin(parsed),
            amountOut: this.extractAmountOut(parsed),
            amountInMaximum: this.extractAmountInMax(parsed),
            recipient: normalizeAddress(params.recipient),
            pools: pool ? [{ tokenIn, tokenOut, fee, poolAddress: pool }] : [],
            rawArgs: params,
            tradeSummary
        };
    }

    async parsePath(parsed) {
        const pathBytes = parsed.args.path;
        const segments = await this.decodePath(pathBytes);
        const tokenIn = segments.length > 0 ? segments[0].tokenIn : null;
        const tokenOut = segments.length > 0 ? segments[segments.length - 1].tokenOut : null;
        const tradeSummary = this.buildTradeSummary(tokenIn, tokenOut, {
            spendAmount: parsed.name === 'exactInput' ? toBigNumber(parsed.args.amountIn) : toBigNumber(parsed.args.amountInMaximum),
            spendType: parsed.name === 'exactInput' ? 'exact' : 'max',
            receiveAmount: parsed.name === 'exactInput' ? toBigNumber(parsed.args.amountOutMinimum) : toBigNumber(parsed.args.amountOut),
            receiveType: parsed.name === 'exactInput' ? 'min' : 'exact'
        });
        return {
            protocol: 'pancake_v3',
            router: this.routerAddress,
            method: parsed.name,
            path: segments,
            amountIn: this.extractAmountIn(parsed),
            amountOutMin: this.extractAmountOutMin(parsed),
            amountOut: this.extractAmountOut(parsed),
            amountInMaximum: this.extractAmountInMax(parsed),
            recipient: normalizeAddress(parsed.args.recipient),
            rawArgs: parsed.args,
            tradeSummary
        };
    }

    normalizeToken(address) {
        if (!address || address === ethers.constants.AddressZero) {
            return this.wbnbAddress;
        }
        return normalizeAddress(address);
    }

    async getPool(tokenA, tokenB, fee) {
        if (!tokenA || !tokenB || typeof fee !== 'number') {
            return null;
        }
        const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
            ? [tokenA, tokenB]
            : [tokenB, tokenA];
        const cacheKey = `${token0.toLowerCase()}-${token1.toLowerCase()}-${fee}`;
        if (this.poolCache.has(cacheKey)) {
            return this.poolCache.get(cacheKey);
        }
        try {
            const pool = await this.factoryContract.getPool(token0, token1, fee);
            if (pool && pool !== ethers.constants.AddressZero) {
                const normalized = normalizeAddress(pool);
                this.poolCache.set(cacheKey, normalized);
                return normalized;
            }
        } catch (err) {
            console.warn(`读取 Pancake v3 pool 失败: ${err.message}`);
        }
        return null;
    }

    async decodePath(pathHex) {
        if (!pathHex || pathHex === '0x') {
            return [];
        }
        const pathBuffer = Buffer.from(pathHex.replace(/^0x/, ''), 'hex');
        const ADDRESS_SIZE = 20;
        const FEE_SIZE = 3;
        if (pathBuffer.length < ADDRESS_SIZE + FEE_SIZE + ADDRESS_SIZE) {
            return [];
        }
        const segments = [];
        let offset = 0;
        let tokenIn = this.normalizeToken(`0x${pathBuffer.slice(offset, offset + ADDRESS_SIZE).toString('hex')}`);
        offset += ADDRESS_SIZE;
        while (offset < pathBuffer.length) {
            const fee = pathBuffer.readUIntBE(offset, FEE_SIZE);
            offset += FEE_SIZE;
            const tokenOutHex = `0x${pathBuffer.slice(offset, offset + ADDRESS_SIZE).toString('hex')}`;
            offset += ADDRESS_SIZE;
            const tokenOut = this.normalizeToken(tokenOutHex);
            const pool = await this.getPool(tokenIn, tokenOut, fee);
            segments.push({
                tokenIn,
                tokenOut,
                fee,
                poolAddress: pool
            });
            tokenIn = tokenOut;
        }
        return segments;
    }

    extractAmountIn(parsed) {
        if (!parsed || !parsed.args) return null;
        switch (parsed.name) {
        case 'exactInputSingle':
        case 'exactInput':
            return ethers.BigNumber.from(parsed.args[0]?.amountIn || parsed.args.amountIn);
        case 'exactOutput':
            return ethers.BigNumber.from(parsed.args.amountInMaximum);
        case 'exactOutputSingle':
            return ethers.BigNumber.from(parsed.args[0]?.amountInMaximum);
        default:
            return null;
        }
    }

    extractAmountOut(parsed) {
        if (!parsed || !parsed.args) return null;
        switch (parsed.name) {
        case 'exactInput':
        case 'exactInputSingle':
            return null;
        case 'exactOutput':
        case 'exactOutputSingle':
            return ethers.BigNumber.from(parsed.args.amountOut || parsed.args[0]?.amountOut);
        default:
            return null;
        }
    }

    extractAmountOutMin(parsed) {
        if (!parsed || !parsed.args) return null;
        switch (parsed.name) {
        case 'exactInputSingle':
            return ethers.BigNumber.from(parsed.args[0]?.amountOutMinimum);
        case 'exactInput':
            return ethers.BigNumber.from(parsed.args.amountOutMinimum);
        default:
            return null;
        }
    }

    extractAmountInMax(parsed) {
        if (!parsed || !parsed.args) return null;
        switch (parsed.name) {
        case 'exactOutput':
            return ethers.BigNumber.from(parsed.args.amountInMaximum);
        case 'exactOutputSingle':
            return ethers.BigNumber.from(parsed.args[0]?.amountInMaximum);
        default:
            return null;
        }
    }

    buildTradeSummary(tokenIn, tokenOut, { spendAmount, spendType, receiveAmount, receiveType }) {
        if (!tokenIn && !tokenOut) {
            return null;
        }
        return buildTradeSummary(
            this.wbnbAddress,
            tokenIn,
            tokenOut,
            spendAmount,
            spendType,
            receiveAmount,
            receiveType
        );
    }
}

class BinanceDexRouterParser {
    constructor({ provider, routerAddress, factoryAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('BinanceDexRouterParser 需要 provider');
        }
        if (!routerAddress) {
            throw new Error('BinanceDexRouterParser 需要 routerAddress');
        }
        this.provider = provider;
        this.routerAddress = normalizeAddress(routerAddress);
        this.factoryAddress = factoryAddress ? normalizeAddress(factoryAddress) : null;
        this.wbnbAddress = wbnbAddress ? normalizeAddress(wbnbAddress) : null;
        this.lowerRouter = this.routerAddress.toLowerCase();
        this.v2FactoryCandidates = this.collectV2Factories();
        this.v2PairCache = new Map();
        this.v3FactoryCandidates = this.collectV3Factories();
        this.v3PoolCache = new Map();
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
            const input = pendingTx.input;
            if (!input || input.length < 10) {
                return null;
            }
            const selector = input.slice(0, 10).toLowerCase();
            const methodLabel = BINANCE_DEX_ROUTER_SELECTORS[selector];
            if (!methodLabel) {
                return null;
            }
            const payload = input.slice(10); // 移除 4 字节方法选择子
            const decoded = this.decodeSwapPayload(payload);
            if (!decoded) {
                return null;
            }
            const {
                executor,
                swapHandler,
                tokenIn,
                tokenOut,
                amountIn,
                amountOutMin,
                rawExtra,
                decodedExtra,
                payload: decodedPayload
            } = decoded;
            const rawTokenIn = tokenIn;
            const rawTokenOut = tokenOut;
            const spendToken = normalizeSwapTokenAddress(rawTokenIn);
            const receiveToken = normalizeSwapTokenAddress(rawTokenOut);
            const finalHop = await this.identifyFinalHop(rawTokenIn, rawTokenOut, decodedExtra);
            const tradeSummary = buildTradeSummary(
                this.wbnbAddress,
                spendToken,
                receiveToken,
                amountIn,
                'exact',
                amountOutMin,
                'min'
            );
            return {
                protocol: 'binance_dex_router',
                router: this.routerAddress,
                method: methodLabel,
                selector,
                executor,
                swapHandler,
                tokenIn: spendToken,
                tokenOut: receiveToken,
                amountIn,
                amountOutMin,
                recipient: normalizeAddress(pendingTx.from),
                rawExtra,
                decodedExtra,
                rawPayload: decodedPayload,
                finalHop,
                tradeSummary
            };
        } catch (err) {
            return null;
        }
    }


    async identifyFinalHop(rawTokenIn, rawTokenOut, decodedExtra = {}) {
    if (!this.wbnbAddress) {
        return null;
    }
    const tokenIn = this.normalizeTokenForPair(rawTokenIn);
    const tokenOut = this.normalizeTokenForPair(rawTokenOut);
    if (!tokenIn || !tokenOut) {
        return null;
    }
    const pairInfo = await this.findV2Pair(tokenIn, tokenOut);
    if (pairInfo) {
        return {
            dexType: pairInfo.dexType,
            tokenIn,
            tokenOut,
            path: [tokenIn, tokenOut],
            poolAddress: pairInfo.pairAddress,
            factory: pairInfo.factory,
            usesNativeInput: !rawTokenIn || rawTokenIn.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
        };
    }
    const poolInfo = await this.findV3Pool(tokenIn, tokenOut, decodedExtra);
    if (poolInfo) {
        return {
            dexType: poolInfo.dexType,
            tokenIn,
            tokenOut,
            path: [tokenIn, tokenOut],
            poolAddress: poolInfo.poolAddress,
            factory: poolInfo.factory,
            fee: poolInfo.fee,
            usesNativeInput: !rawTokenIn || rawTokenIn.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
        };
    }
    return null;
}

    normalizeTokenForPair(address) {
    if (!address) {
        return this.wbnbAddress;
    }
    try {
        const normalized = ethers.utils.getAddress(address);
        if (normalized === ethers.constants.AddressZero) {
            return this.wbnbAddress;
        }
        return normalized;
    } catch (err) {
        return null;
    }
}

    async findV2Pair(tokenA, tokenB) {
    if (!tokenA || !tokenB) {
        return null;
    }
    if (!this.v2FactoryCandidates || this.v2FactoryCandidates.length === 0) {
        return null;
    }
    const [token0, token1] = this.sortTokens(tokenA, tokenB);
    const cacheKey = `${token0.toLowerCase()}-${token1.toLowerCase()}`;
    if (this.v2PairCache.has(cacheKey)) {
        return this.v2PairCache.get(cacheKey);
    }
    for (const candidate of this.v2FactoryCandidates) {
        try {
            const factory = new ethers.Contract(candidate.factory, FACTORY_ABI, this.provider);
            const pair = await factory.getPair(token0, token1);
            if (pair && pair !== ethers.constants.AddressZero) {
                const info = {
                    pairAddress: ethers.utils.getAddress(pair),
                    factory: candidate.factory,
                    dexType: candidate.dexType
                };
                this.v2PairCache.set(cacheKey, info);
                return info;
            }
        } catch (err) {
            continue;
        }
    }
    this.v2PairCache.set(cacheKey, null);
    return null;
}

    sortTokens(tokenA, tokenB) {
    return tokenA.toLowerCase() < tokenB.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];
}

    collectV2Factories() {
    const candidates = [];
    const seen = new Set();
    const push = (addr, dexType) => {
        if (!addr) return;
        let normalized;
        try {
            normalized = ethers.utils.getAddress(addr);
        } catch (err) {
            return;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ factory: normalized, dexType });
    };
    if (this.factoryAddress) {
        push(this.factoryAddress, 'pancake_v2');
    }
    push(process.env.PCS_V2_FACTORY, 'pancake_v2');
    push(process.env.UNI_V2_FACTORY, 'uniswap_v2');
    return candidates;
}

    collectV3Factories() {
    const candidates = [];
    const seen = new Set();
    const push = (addr, dexType) => {
        if (!addr) return;
        let normalized;
        try {
            normalized = ethers.utils.getAddress(addr);
        } catch (err) {
            return;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ factory: normalized, dexType });
    };
    push(process.env.PCS_V3_FACTORY, 'pancake_v3');
    push(process.env.UNI_V3_FACTORY, 'uniswap_v3');
    return candidates;
}

    async findV3Pool(tokenIn, tokenOut, decodedExtra = {}) {
    if (!tokenIn || !tokenOut || !this.v3FactoryCandidates || this.v3FactoryCandidates.length === 0) {
        return null;
    }
    const candidates = new Set();
    if (decodedExtra && Array.isArray(decodedExtra.addressHints)) {
        decodedExtra.addressHints.forEach(addr => {
            if (!addr) return;
            try {
                candidates.add(ethers.utils.getAddress(addr));
            } catch (err) {
                /* ignore */
            }
        });
    }
    if (decodedExtra && decodedExtra.metadata) {
        const meta = decodedExtra.metadata;
        const addrs = [];
        if (meta.poolAddress) addrs.push(meta.poolAddress);
        if (Array.isArray(meta.routes)) {
            meta.routes.forEach(route => {
                if (route?.poolAddress) addrs.push(route.poolAddress);
            });
        }
        addrs.forEach(addr => {
            if (!addr) return;
            try {
                candidates.add(ethers.utils.getAddress(addr));
            } catch (err) {
                /* ignore */
            }
        });
    }
    if (candidates.size === 0) {
        return null;
    }
    const targetKey = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join('-');
    if (!this.v3PoolCache) {
        this.v3PoolCache = new Map();
    }
    for (const addr of candidates) {
        const cacheKey = addr.toLowerCase();
        if (this.v3PoolCache.has(cacheKey)) {
            const cached = this.v3PoolCache.get(cacheKey);
            if (cached && cached.tokensKey === targetKey) {
                return cached.info;
            }
            continue;
        }
        try {
            const pool = new ethers.Contract(addr, V3_POOL_ABI, this.provider);
            const [token0, token1, fee, factory] = await Promise.all([
                pool.token0(),
                pool.token1(),
                pool.fee(),
                pool.factory()
            ]);
            const normalized0 = ethers.utils.getAddress(token0);
            const normalized1 = ethers.utils.getAddress(token1);
            const key = [normalized0.toLowerCase(), normalized1.toLowerCase()].sort().join('-');
            const info = {
                poolAddress: addr,
                factory: ethers.utils.getAddress(factory),
                fee,
                dexType: this.resolveV3DexType(factory)
            };
            this.v3PoolCache.set(cacheKey, { tokensKey: key, info });
            if (info.dexType && key === targetKey) {
                return info;
            }
        } catch (err) {
            this.v3PoolCache.set(cacheKey, null);
        }
    }
    return null;
}

    resolveV3DexType(factoryAddress) {
    if (!factoryAddress) {
        return null;
    }
    try {
        const normalized = ethers.utils.getAddress(factoryAddress);
        const lower = normalized.toLowerCase();
        for (const candidate of this.v3FactoryCandidates || []) {
            if (candidate.factory.toLowerCase() === lower) {
                return candidate.dexType;
            }
        }
    } catch (err) {
        return null;
    }
    return null;
}



        decodeSwapPayload(payload) {
        if (!payload || payload.length % 2 !== 0) {
            return null;
        }
        const readWord = (index) => {
            const start = index * 64;
            const end = start + 64;
            if (end > payload.length) {
                return null;
            }
            return payload.slice(start, end);
        };
        const readAddress = (index) => {
            const word = readWord(index);
            if (!word) {
                return null;
            }
            const addrHex = word.slice(24);
            return normalizeAddress('0x' + addrHex);
        };
        const readUint = (index) => {
            const word = readWord(index);
            if (!word) {
                return null;
            }
            return toBigNumber('0x' + word);
        };

        const executor = readAddress(0);
        const swapHandler = readAddress(1);
        const tokenIn = readAddress(2);
        const amountIn = readUint(3);
        const tokenOut = readAddress(4);
        const amountOutMin = readUint(5);
        if (!tokenIn && !tokenOut) {
            return null;
        }
        const offsetWord = readWord(6);
        const { rawExtra, decodedExtra } = this.extractExtraBytes(payload, offsetWord);
        return {
            executor,
            swapHandler,
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            rawExtra,
            decodedExtra,
            payload
        };
    }

    extractExtraBytes(payload, offsetWord) {
        if (!offsetWord) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        let offset;
        try {
            offset = BigInt('0x' + offsetWord);
        } catch (err) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        if (offset === 0n) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        const dataStart = Number(offset) * 2;
        if (!Number.isSafeInteger(dataStart) || dataStart + 64 > payload.length) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        const lengthWord = payload.slice(dataStart, dataStart + 64);
        let length;
        try {
            length = BigInt('0x' + lengthWord);
        } catch (err) {
            length = 0n;
        }
        const byteLen = Number(length);
        if (!Number.isSafeInteger(byteLen) || byteLen < 0) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        const bodyStart = dataStart + 64;
        const bodyEnd = bodyStart + byteLen * 2;
        if (bodyEnd > payload.length) {
            return { rawExtra: '0x', decodedExtra: this.decodeExtraData('0x') };
        }
        const hexBody = payload.slice(bodyStart, bodyEnd);
        const rawExtra = `0x${hexBody}`;
        return { rawExtra, decodedExtra: this.decodeExtraData(rawExtra) };
    }

    decodeExtraData(rawData) {
        if (!rawData || rawData === '0x') {
            return {
                addressHints: [],
                metadata: null
            };
        }
        const lower = rawData.slice(2);
        const words = [];
        for (let offset = 0; offset + 64 <= lower.length; offset += 64) {
            const chunk = lower.slice(offset, offset + 64);
            words.push(chunk);
        }
        const addressSet = new Set();
        let signature = null;
        let callSelector = null;
        let orderHint = null;
        if (lower.length >= 8) {
            callSelector = `0x${lower.slice(0, 8)}`;
            if (lower.length >= 72) {
                try {
                    orderHint = ethers.BigNumber.from(`0x${lower.slice(8, 72)}`);
                } catch (err) {
                    orderHint = null;
                }
            }
        }
        for (const word of words) {
            if (word.startsWith('000000000000000000000000')) {
                const addrHex = word.slice(24);
                if (!/^0{40}$/.test(addrHex)) {
                    try {
                        addressSet.add(ethers.utils.getAddress('0x' + addrHex));
                    } catch (err) {
                        // ignore invalid checksum
                    }
                }
            }
        }
        // 提取末尾 JSON 元信息与签名
        let metadata = null;
        if (lower.length % 2 === 0) {
            try {
                const ascii = Buffer.from(lower, 'hex').toString('utf8');
                const marker = ascii.indexOf('{"Source"');
                if (marker !== -1) {
                    const jsonSlice = ascii.slice(marker).replace(/\u0000+$/, '');
                    metadata = JSON.parse(jsonSlice);
                }
                if (!signature) {
                    const match = /"Signature"\s*:\s*"([^"]+)"/.exec(ascii);
                    if (match && match[1]) {
                        signature = match[1];
                    }
                }
            } catch (err) {
                metadata = null;
            }
        }
        if (!signature && metadata && metadata.IntegrityInfo && metadata.IntegrityInfo.Signature) {
            signature = metadata.IntegrityInfo.Signature;
        }
        return {
            addressHints: Array.from(addressSet),
            metadata,
            signature,
            callSelector,
            orderHint
        };
    }
}

class SmartSwapOrderParser {
    constructor({ provider, contractAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('SmartSwapOrderParser 需要 provider');
        }
        if (!contractAddress) {
            throw new Error('SmartSwapOrderParser 需要 contractAddress');
        }
        if (!wbnbAddress) {
            throw new Error('SmartSwapOrderParser 需要 wbnbAddress');
        }
        this.provider = provider;
        this.contractAddress = normalizeAddress(contractAddress);
        this.wbnbAddress = normalizeAddress(wbnbAddress);
        this.lowerContract = this.contractAddress.toLowerCase();
    }

    supports(pendingTx) {
        if (!pendingTx || !pendingTx.to) {
            return false;
        }
        return pendingTx.to.toLowerCase() === this.lowerContract;
    }

    async parse(pendingTx) {
        if (!this.supports(pendingTx)) {
            return null;
        }
        const input = pendingTx.input;
        if (!input || input.length < 10) {
            return null;
        }
        const selector = input.slice(0, 10).toLowerCase();
        if (!SMART_SWAP_SELECTORS.has(selector)) {
            return null;
        }
        const words = splitWords(input.slice(10));
        if (words.length < 6) {
            return null;
        }
        const orderId = toBigNumber(`0x${words[0]}`);
        const rawTokenIn = wordToAddress(words[1]);
        const rawTokenOut = wordToAddress(words[2]);
        const amountIn = toBigNumber(`0x${words[3]}`);
        const minReturn = toBigNumber(`0x${words[4]}`);
        const deadline = toBigNumber(`0x${words[5]}`);
        const tokenIn = normalizeSwapTokenAddress(rawTokenIn);
        const tokenOut = normalizeSwapTokenAddress(rawTokenOut);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            tokenIn,
            tokenOut,
            amountIn,
            'exact',
            minReturn,
            'min'
        );
        const batchMeta = this.extractBatchInfo(words);
        return {
            protocol: 'smart_swap_order',
            contract: this.contractAddress,
            method: 'smartSwapByOrderId',
            selector,
            orderId,
            tokenIn,
            tokenOut,
            amountIn,
            minReturn,
            deadline,
            batchesAmount: batchMeta.amounts,
            maker: normalizeAddress(pendingTx.from),
            beneficiary: batchMeta.beneficiary,
            recipient: batchMeta.beneficiary || normalizeAddress(pendingTx.from),
            rawExtra: batchMeta.rawExtra,
            tradeSummary
        };
    }

    extractBatchInfo(words) {
        try {
            if (!Array.isArray(words) || words.length < 30) {
                return { amounts: null, beneficiary: this.extractBeneficiary(words), rawExtra: this.buildRawExtra(words) };
            }
            // batchesAmount 推测存放在 dynamic offset (words[6]) 指向数据
            const firstOffset = Number(BigInt(`0x${words[6]}`));
            if (!Number.isSafeInteger(firstOffset) || firstOffset === 0) {
                return { amounts: null, beneficiary: this.extractBeneficiary(words), rawExtra: this.buildRawExtra(words) };
            }
            const lengthIndex = firstOffset / 32;
            if (!Number.isInteger(lengthIndex) || lengthIndex + 1 > words.length) {
                return { amounts: null, beneficiary: this.extractBeneficiary(words), rawExtra: this.buildRawExtra(words) };
            }
            const amountCount = Number(BigInt(`0x${words[lengthIndex]}`));
            const amounts = [];
            for (let i = 0; i < amountCount; i++) {
                const idx = lengthIndex + 1 + i;
                if (idx >= words.length) break;
                amounts.push(toBigNumber(`0x${words[idx]}`));
            }
            return {
                amounts: amounts.length > 0 ? amounts : null,
                beneficiary: this.extractBeneficiary(words),
                rawExtra: this.buildRawExtra(words)
            };
        } catch (err) {
            return { amounts: null, beneficiary: null, rawExtra: null };
        }
    }

    extractBeneficiary(words) {
        if (!Array.isArray(words) || words.length === 0) {
            return null;
        }
        const tail = words[words.length - 1];
        const addr = tail ? wordToAddress(tail) : null;
        if (!addr) {
            return null;
        }
        if (addr.toLowerCase() === ZERO_ADDRESS_LOWER) {
            return null;
        }
        return addr;
    }

    buildRawExtra(words) {
        if (!Array.isArray(words) || words.length <= 28) {
            return null;
        }
        return `0x${words.slice(28).join('')}`;
    }
}

class MemeProxyRouterParser {
    constructor({ provider, proxyAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('MemeProxyRouterParser 需要 provider');
        }
        if (!proxyAddress) {
            throw new Error('MemeProxyRouterParser 需要 proxyAddress');
        }
        if (!wbnbAddress) {
            throw new Error('MemeProxyRouterParser 需要 wbnbAddress');
        }
        this.provider = provider;
        this.proxyAddress = normalizeAddress(proxyAddress);
        this.wbnbAddress = normalizeAddress(wbnbAddress);
        this.lowerProxy = this.proxyAddress.toLowerCase();
        this.interface = new ethers.utils.Interface(MEME_PROXY_ABI);
    }

    supports(pendingTx) {
        if (!pendingTx || !pendingTx.to) {
            return false;
        }
        return pendingTx.to.toLowerCase() === this.lowerProxy;
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
            switch (parsed.name) {
            case 'buyMemeToken':
                return this.handleBuy(pendingTx, parsed);
            case 'sellMemeToken':
                return this.handleSell(pendingTx, parsed);
            case 'swapV2ExactIn':
                return this.handleSwapV2(pendingTx, parsed);
            case 'swapV3ExactIn':
                return this.handleSwapV3(pendingTx, parsed);
            default:
                return null;
            }
        } catch (err) {
            return null;
        }
    }

    handleBuy(pendingTx, parsed) {
        const args = parsed.args;
        const token = normalizeSwapTokenAddress(args.token);
        const recipient = normalizeAddress(args.recipient);
        const funds = toBigNumber(args.funds);
        const minAmount = toBigNumber(args.minAmount);
        const valueBn = toBigNumber(pendingTx.value || '0x0');
        const spendAmount = valueBn && !valueBn.isZero() ? valueBn : funds;
        const spendToken = valueBn && !valueBn.isZero() ? ethers.constants.AddressZero : this.wbnbAddress;
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            spendToken,
            token,
            spendAmount,
            'exact',
            minAmount,
            'min'
        );
        return {
            protocol: 'meme_proxy_router',
            router: this.proxyAddress,
            method: 'buyMemeToken',
            tokenManager: normalizeAddress(args.tokenManager),
            token,
            recipient,
            funds,
            minAmount,
            value: valueBn,
            tradeSummary
        };
    }

    handleSell(pendingTx, parsed) {
        const data = parsed.args.data;
        const token = normalizeSwapTokenAddress(data.token);
        const amountIn = toBigNumber(data.amountIn);
        const minAmount = toBigNumber(data.amountOutMinimum);
        const feeToken = normalizeSwapTokenAddress(data.feeToken);
        const tokenOut = feeToken || this.wbnbAddress;
        const recipient = normalizeAddress(data.payerOrigin) || normalizeAddress(pendingTx.from);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            token,
            tokenOut,
            amountIn,
            'exact',
            minAmount,
            'min'
        );
        return {
            protocol: 'meme_proxy_router',
            router: this.proxyAddress,
            method: 'sellMemeToken',
            data: {
                token,
                payerOrigin: normalizeAddress(data.payerOrigin),
                feeRecipient: normalizeAddress(data.feeRecipient),
                feeToken,
                factory: normalizeAddress(data.factory),
                fee: data.fee,
                route: data.route
            },
            amountIn,
            minAmount,
            recipient,
            tradeSummary
        };
    }

    handleSwapV2(pendingTx, parsed) {
        const tokenIn = normalizeSwapTokenAddress(parsed.args.tokenIn);
        const tokenOut = normalizeSwapTokenAddress(parsed.args.tokenOut);
        const amountIn = toBigNumber(parsed.args.amountIn);
        const amountOutMin = toBigNumber(parsed.args.amountOutMin);
        const poolAddress = normalizeAddress(parsed.args.poolAddress);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            tokenIn,
            tokenOut,
            amountIn,
            'exact',
            amountOutMin,
            'min'
        );
        return {
            protocol: 'meme_proxy_router',
            router: this.proxyAddress,
            method: 'swapV2ExactIn',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            poolAddress,
            recipient: normalizeAddress(pendingTx.from),
            tradeSummary
        };
    }

    handleSwapV3(pendingTx, parsed) {
        const params = parsed.args.params;
        const tokenIn = normalizeSwapTokenAddress(params.tokenIn);
        const tokenOut = normalizeSwapTokenAddress(params.tokenOut);
        const amountIn = toBigNumber(params.amountIn);
        const amountOutMin = toBigNumber(params.amountOutMinimum);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            tokenIn,
            tokenOut,
            amountIn,
            'exact',
            amountOutMin,
            'min'
        );
        return {
            protocol: 'meme_proxy_router',
            router: this.proxyAddress,
            method: 'swapV3ExactIn',
            params: {
                factoryAddress: normalizeAddress(params.factoryAddress),
                poolAddress: normalizeAddress(params.poolAddress),
                recipient: normalizeAddress(params.recipient),
                deadline: toBigNumber(params.deadline),
                fee: params.fee,
                sqrtPriceLimitX96: toBigNumber(params.sqrtPriceLimitX96)
            },
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            tradeSummary
        };
    }
}

class FourMemeRouterParser {
    constructor({ provider, contractAddress, wbnbAddress }) {
        if (!provider) {
            throw new Error('FourMemeRouterParser 需要 provider');
        }
        this.provider = provider;
        this.contractAddress = normalizeAddress(contractAddress || FOUR_MEME_ROUTER_ADDRESS);
        this.wbnbAddress = normalizeAddress(wbnbAddress);
        this.lowerAddress = this.contractAddress.toLowerCase();
    }

    supports(pendingTx) {
        if (!pendingTx || !pendingTx.to) {
            return false;
        }
        return pendingTx.to.toLowerCase() === this.lowerAddress;
    }

    async parse(pendingTx) {
        if (!this.supports(pendingTx)) {
            return null;
        }
        if (!pendingTx.input || pendingTx.input.length < 10) {
            return null;
        }
        const selector = pendingTx.input.slice(0, 10).toLowerCase();
        switch (selector) {
        case '0xedf9e251':
            return this.parseBuyToken(pendingTx, selector);
        case '0xe63aaf36':
            return this.parseSellTokenLegacy(pendingTx, selector);
        case '0x0da74935':
            return this.parseSellTokenSimple(pendingTx, selector);
        default:
            return null;
        }
    }

    parseBuyToken(pendingTx, selector) {
        const words = splitWords(pendingTx.input.slice(10));
        if (words.length < 4) {
            return null;
        }
        const routeId = toBigNumber('0x' + words[0]);
        const token = normalizeAddress('0x' + words[1].slice(24));
        const amountIn = toBigNumber('0x' + words[2]);
        const minAmount = toBigNumber('0x' + words[3]);
        const recipient = normalizeAddress(pendingTx.from);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            ethers.constants.AddressZero,
            token,
            amountIn,
            'exact',
            minAmount,
            'min'
        );
        return {
            protocol: 'fourmeme_router',
            router: this.contractAddress,
            method: 'buyToken',
            selector,
            routeId,
            tokenIn: ethers.constants.AddressZero,
            tokenOut: token,
            amountIn,
            amountOutMin: minAmount,
            recipient,
            extra: {},
            rawWords: words,
            tradeSummary
        };
    }

    parseSellTokenLegacy(pendingTx, selector) {
        const words = splitWords(pendingTx.input.slice(10));
        if (words.length < 7) {
            return null;
        }
        const routeId = toBigNumber('0x' + words[0]);
        const token = normalizeAddress('0x' + words[1].slice(24));
        const recipient = normalizeAddress('0x' + words[2].slice(24));
        const amountIn = toBigNumber('0x' + words[3]);
        const minReturn = toBigNumber('0x' + words[4]);
        const slippageBps = toBigNumber('0x' + words[5]);
        const feeRecipient = normalizeAddress('0x' + words[6].slice(24));
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            token,
            ethers.constants.AddressZero,
            amountIn,
            'exact',
            minReturn,
            'min'
        );
        return {
            protocol: 'fourmeme_router',
            router: this.contractAddress,
            method: 'sellTokenForBNB',
            selector,
            routeId,
            tokenIn: token,
            tokenOut: ethers.constants.AddressZero,
            amountIn,
            amountOutMin: minReturn,
            recipient,
            extra: {
                slippageBps,
                feeRecipient
            },
            rawWords: words,
            tradeSummary
        };
    }

    parseSellTokenSimple(pendingTx, selector) {
        const words = splitWords(pendingTx.input.slice(10));
        if (words.length < 4) {
            return null;
        }
        const routeId = toBigNumber('0x' + words[0]);
        const token = normalizeAddress('0x' + words[1].slice(24));
        const amountIn = toBigNumber('0x' + words[2]);
        const minReturn = toBigNumber('0x' + words[3]);
        const tradeSummary = buildTradeSummary(
            this.wbnbAddress,
            token,
            ethers.constants.AddressZero,
            amountIn,
            'exact',
            minReturn,
            'min'
        );
        return {
            protocol: 'fourmeme_router',
            router: this.contractAddress,
            method: 'sellToken',
            selector,
            routeId,
            tokenIn: token,
            tokenOut: ethers.constants.AddressZero,
            amountIn,
            amountOutMin: minReturn,
            recipient: normalizeAddress(pendingTx.from),
            extra: {},
            rawWords: words,
            tradeSummary
        };
    }
}

module.exports = {
    PancakeV2Parser,
    PancakeV3Parser,
    BinanceDexRouterParser,
    SmartSwapOrderParser,
    MemeProxyRouterParser,
    FourMemeRouterParser
};
