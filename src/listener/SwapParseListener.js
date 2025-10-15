const { resolve } = require('path');
const { ethers } = require('ethers');
const {
    PancakeV2Parser,
    PancakeV3Parser,
    BinanceDexRouterParser,
    SmartSwapOrderParser,
    MemeProxyRouterParser,
    FourMemeRouterParser
} = require('../parser/SwapParsers');
const { buildParseResultModel } = require('../parser/ParseResultModel');
const { swapEventBus } = require('../events/SwapEventBus');
const { createLogger } = require('../utils/Logger');

require('dotenv').config({ path: resolve(__dirname, '../../.env') });

class SwapParseListener {
    constructor(initMonitorAddressList = [], options = {}) {
        const wssUrl = process.env.BSC_WSS_URL;
        if (!wssUrl) {
            throw new Error('缺少 BSC_WSS_URL');
        }
        const wbnbAddress = process.env.WBNB_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
        if (!wbnbAddress) {
            throw new Error('缺少 WBNB_ADDRESS');
        }

        this.logger = createLogger('SwapParseListener');
        this.wsProvider = this.createProvider(wssUrl);
        this.listenMode = this.normalizeMode(options.listenMode) || this.resolveListenMode();
        this.monitorAddressMap = new Map();
        const addresses = initMonitorAddressList.length > 0
            ? initMonitorAddressList
            : (process.env.MONITOR_ADDRESSES || '')
                .split(',')
                .map(addr => addr.trim())
                .filter(Boolean);
        addresses.forEach(addr => {
            this.monitorAddressMap.set(addr.toLowerCase(), true);
        });
        this.logger.info(`已加载 ${this.monitorAddressMap.size} 个监控地址`);

        const parserConfigs = [];
        const provider = this.wsProvider;

        // pcsV2
        const pcsV2Router = process.env.PCS_V2_ROUTER;
        const pcsV2Factory = process.env.PCS_V2_FACTORY;
        if (pcsV2Router && pcsV2Factory) {
            parserConfigs.push(new PancakeV2Parser({
                provider,
                routerAddress: pcsV2Router,
                factoryAddress: pcsV2Factory,
                wbnbAddress
            }));
        } else {
            this.logger.warn('未配置 PCS_V2_ROUTER 或 PCS_V2_FACTORY，Pancake v2 将不会解析');
        }

        // pcsV3
        const pcsV3Router = process.env.PCS_V3_ROUTER;
        const pcsV3Factory = process.env.PCS_V3_FACTORY;
        if (pcsV3Router && pcsV3Factory) {
            parserConfigs.push(new PancakeV3Parser({
                provider,
                routerAddress: pcsV3Router,
                factoryAddress: pcsV3Factory,
                wbnbAddress
            }));
        } else {
            this.logger.warn('未配置 PCS_V3_ROUTER 或 PCS_V3_FACTORY，Pancake v3 将不会解析');
        }

        // smartSwapContract
        // const smartSwapContract = process.env.SMART_SWAP_ORDER_CONTRACT || "0x3d90f66B534Dd8482b181e24655A9e8265316BE9";
        // if (smartSwapContract) {
        //     parserConfigs.push(new SmartSwapOrderParser({
        //         provider,
        //         contractAddress: smartSwapContract,
        //         wbnbAddress
        //     }));
        // } else {
        //     this.logger.warn('未配置 SMART_SWAP_ORDER_CONTRACT，smartSwapByOrderId 将不会解析');
        // }

        // memeProxyRouter
        const memeProxyRouter = process.env.MEME_PROXY_ROUTER || "0x1de460f363AF910f51726DEf188F9004276Bf4bc";
        if (memeProxyRouter) {
            parserConfigs.push(new MemeProxyRouterParser({
                provider,
                proxyAddress: memeProxyRouter,
                wbnbAddress
            }));
        } else {
            this.logger.warn('未配置 MEME_PROXY_ROUTER，buyMemeToken/sellMemeToken 将不会解析');
        }

        // binanceRouter
        const binanceRouter = process.env.BINANCE_DEX_ROUTER || "0xb300000b72DEAEb607a12d5f54773D1C19c7028d";
        const binanceFactory = process.env.PCS_V2_FACTORY || process.env.BINANCE_DEX_FACTORY;
        if (binanceRouter && binanceFactory) {
            parserConfigs.push(new BinanceDexRouterParser({
                provider,
                routerAddress: binanceRouter,
                factoryAddress: binanceFactory,
                wbnbAddress
            }));
        } else {
            this.logger.warn('未配置 BINANCE_DEX_ROUTER 或相关 factory，Binance DEX Router 将不会解析');
        }


        // fourmeme
        const fourMemeRouter = process.env.FOUR_MEME_ROUTER || '0x5C952063C7fC8610ffDB798152D69F0B9550762B';
        if (fourMemeRouter) {
            parserConfigs.push(new FourMemeRouterParser({
                provider,
                contractAddress: fourMemeRouter,
                wbnbAddress
            }));
        } else {
            this.logger.warn('未配置 FOUR_MEME_ROUTER，fourmeme 合约将不会解析');
        }

        if (parserConfigs.length === 0) {
            throw new Error('缺少任何解析器配置');
        }
        this.parsers = parserConfigs;
    }

    normalizeMode(mode) {
        if (!mode) {
            return null;
        }
        const lowered = String(mode).toLowerCase();
        if (lowered === 'logs') {
            this.logger.warn('监听模式 logs 已取消支持，将自动回退为 block');
            return 'block';
        }
        if (['pending', 'block'].includes(lowered)) {
            return lowered;
        }
        return null;
    }

    resolveListenMode() {
        const explicit = (process.env.LISTEN_MODE || process.env.SWAP_LISTEN_MODE || '').toLowerCase();
        const normalized = this.normalizeMode(explicit);
        if (normalized) {
            return normalized;
        }
        const mempoolEnv = process.env.MEMPOOL_MODE ?? process.env.MEMPOOL;
        if (mempoolEnv !== undefined) {
            return String(mempoolEnv).toLowerCase() === 'true' ? 'pending' : 'block';
        }
        return 'pending';
    }

    createProvider(wssUrl) {
        const provider = new ethers.providers.WebSocketProvider(wssUrl);
        provider.getResolver = async () => null;
        const originalResolveName = provider.resolveName.bind(provider);
        provider.resolveName = async (name) => {
            if (typeof name === 'string' && name.startsWith('0x') && ethers.utils.isAddress(name)) {
                return ethers.utils.getAddress(name);
            }
            try {
                return await originalResolveName(name);
            } catch (err) {
                return null;
            }
        };
        provider._websocket.on('open', () => {
            this.logger.info('WebSocket 已连接');
        });
        provider._websocket.on('error', (err) => {
            this.logger.error('WebSocket 错误:', err.message);
            provider._websocket.terminate();
            setTimeout(() => this.createProvider(wssUrl), 5000);
        });
        provider._websocket.on('close', () => {
            this.logger.warn('WebSocket 已关闭，尝试重连...');
            setTimeout(() => this.createProvider(wssUrl), 5000);
        });
        return provider;
    }

    async start() {
        if (this.listenMode === 'pending') {
            await this.wsProvider._subscribe(
                'newPendingTransactions',
                ['newPendingTransactions', true],
                async (tx) => this.handleTx(tx)
            );
            this.logger.info('SwapParseListener 已启动，模式: pending');
        } else {
            this.blockListener = async (blockNumber) => this.handleBlock(blockNumber);
            this.wsProvider.on('block', this.blockListener);
            this.logger.info('SwapParseListener 已启动，模式: block');
        }
    }

    async handleBlock(blockNumber) {
        try {
            const startTime = Date.now();
            const block = await this.wsProvider.getBlockWithTransactions(blockNumber);
            this.logger.info(`获取区块 ${blockNumber} 详情耗时 ${Date.now() - startTime} ms`);
            if (!block || !Array.isArray(block.transactions)) {
                return;
            }
            for (const tx of block.transactions) {
                await this.handleTx(tx, { blockNumber });
            }
        } catch (err) {
            this.logger.error(`处理区块 ${blockNumber} 失败:`, err.message);
        }
    }

    async handleTx(pendingTx, meta = {}) {
        try {

            if (!pendingTx || !pendingTx.from || !pendingTx.to || !pendingTx.input) {
                return;
            }

            const senderLower = pendingTx.from.toLowerCase();
            if (!this.monitorAddressMap.has(senderLower)) {
                return;
            }

            const normalizedTx = this.normalizeTransaction(pendingTx);
            for (const parser of this.parsers) {
                const result = await parser.parse(normalizedTx);
                if (result) {
                    const model = buildParseResultModel(normalizedTx, result);
                    // todo 非buy的不管
                    if (model.action !== 'buy') {
                        break;
                    }
                    this.sendSwapEvent(normalizedTx, result, model, meta);
                    this.printResult(normalizedTx, result, model, meta);
                    break;
                }
            }
        } catch (err) {
            this.logger.error('解析交易失败:', err.message);
        }
    }

    normalizeTransaction(rawTx) {
        if (!rawTx) {
            return rawTx;
        }
        const hasUsefulInput = typeof rawTx.input === 'string' && rawTx.input !== '0x' && rawTx.input !== '0x0' && rawTx.input.length > 2;
        if (hasUsefulInput) {
            if (!rawTx.data) {
                return { ...rawTx, data: rawTx.input };
            }
            return rawTx;
        }
        const candidate = typeof rawTx.data === 'string' && rawTx.data.length > 2 && rawTx.data !== '0x0'
            ? rawTx.data
            : rawTx.input;
        if (!candidate) {
            return rawTx;
        }
        return {
            ...rawTx,
            input: candidate,
            data: candidate
        };
    }

    sendSwapEvent(pendingTx, result, model, meta = {}) {
        swapEventBus.emit('swap.parsed', {
            model,
            pendingTx,
            parserResult: result,
            meta
        });
    }

    printResult(pendingTx, result, model, meta = {}) {
        let modeLabel;
        switch (this.listenMode) {
        case 'pending':
            modeLabel = 'pending';
            break;
        case 'block':
            modeLabel = `block:${meta.blockNumber ?? 'n/a'}`;
            break;
        default:
            modeLabel = 'unknown';
        }


        this.logger.info(`[swap][${modeLabel}] ${model.timestamp}`);
        this.logger.info('================ 解析结果 ================');
        this.logger.info(`发送者: ${model.sender || pendingTx.from || '未知'}`);
        this.logger.info(`目标路由: ${model.target || pendingTx.to || '未知'}`);
        if (model.txHash) {
            this.logger.info(`txHash: ${model.txHash}`);
        }
        this.logger.info(`协议: ${model.protocol}`);
        this.logger.info(`方法: ${model.method}`);
        const spendToken = model.tokens.spend;
        const receiveToken = model.tokens.receive;
        if (spendToken) {
            const spendSymbol = spendToken.symbol || '未知';
            this.logger.info(`支付代币: ${spendSymbol} (${spendToken.address || '未知地址'})`);
        }
        if (receiveToken) {
            const receiveSymbol = receiveToken.symbol || '未知';
            this.logger.info(`目标代币: ${receiveSymbol} (${receiveToken.address || '未知地址'})`);
        }
        if (result.path) {
            this.logger.info('路径:');
            result.path.forEach((seg, idx) => {
                this.logger.info(`  [${idx}] ${seg.tokenIn} -> ${seg.tokenOut} fee=${seg.fee} pool=${seg.poolAddress || '未知'}`);
            });
        } else if (result.pools) {
            this.logger.info('池子列表:');
            result.pools.forEach((pool, idx) => {
                this.logger.info(`  [${idx}] ${pool.tokenIn} -> ${pool.tokenOut} ${pool.pairAddress || pool.poolAddress || '未知'}`);
            });
        }
        if (model.amountIn) {
            this.logger.info(`amountIn: ${model.amountIn}`);
        }
        if (model.amountOutMin) {
            this.logger.info(`amountOutMin: ${model.amountOutMin}`);
        }
        if (model.amountOut) {
            this.logger.info(`amountOut: ${model.amountOut}`);
        }
        if (model.amountInMax) {
            this.logger.info(`amountInMax: ${model.amountInMax}`);
        }
        this.logger.info(`接收者: ${model.recipient || '未知'}`);
        if (model.action) {
            this.logger.info(`动作: ${model.action}`);
        }
        const spend = model.amounts.spend;
        if (spend?.formatted) {
            const prefix = spend.type === 'max' ? '<= ' : '';
            this.logger.info(`花费: ${prefix}${spend.formatted}`);
        }
        const receive = model.amounts.receive;
        if (receive?.formatted) {
            let prefix = '';
            if (receive.type === 'min') {
                prefix = '>= ';
            } else if (receive.type === 'max') {
                prefix = '<= ';
            }
            this.logger.info(`得到: ${prefix}${receive.formatted}`);
        }
        if (result.decodedExtra) {
            if (result.decodedExtra.addressHints && result.decodedExtra.addressHints.length > 0) {
                this.logger.info('可能相关地址:');
                result.decodedExtra.addressHints.forEach((addr, idx) => {
                    this.logger.info(`  [${idx}] ${addr}`);
                });
            }
            if (result.decodedExtra.metadata) {
                this.logger.info('附加元信息(JSON):');
                this.logger.info(JSON.stringify(result.decodedExtra.metadata, null, 2));
            }
            if (result.decodedExtra.signature) {
                this.logger.info(`Integrity Signature: ${result.decodedExtra.signature}`);
            }
        }
        this.logger.info('=========================================');
    }
}

async function startSwapParseListener(options = {}) {
    let monitorAddresses;
    if (Array.isArray(options.monitorAddresses)) {
        monitorAddresses = options.monitorAddresses;
    } else if (typeof options.monitorAddresses === 'string') {
        monitorAddresses = options.monitorAddresses.split(',');
    } else {
        monitorAddresses = (process.env.MONITOR_ADDRESSES || '').split(',');
    }
    const normalizedList = monitorAddresses
        .map(addr => addr.trim())
        .filter(Boolean);
    const listener = new SwapParseListener(normalizedList, { listenMode: options.listenMode });
    await listener.start();

    const shutdown = async () => {
        listener.logger?.warn('SwapParseListener 正在关闭...');
        try {
            if (listener.wsProvider && listener.wsProvider._websocket) {
                listener.wsProvider._websocket.terminate();
            }
        } catch (err) {
            listener.logger?.error('关闭 WebSocket 失败:', err.message);
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return listener;
}

module.exports = {
    SwapParseListener,
    startSwapParseListener
};

if (require.main === module) {
    (async () => {
        try {
            await startSwapParseListener();
        } catch (err) {
            const bootstrapLogger = createLogger('SwapParseListener');
            bootstrapLogger.error('SwapParseListener 启动失败:', err.message);
            bootstrapLogger.error(err);
            process.exit(1);
        }
    })();
}
