#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { SwapBuyer } = require('./src/buyer');
const { ensureAllowance, normalizeAddress } = require('./src/buyer/helpers');
const { buildParseResultModel } = require('./src/parser/ParseResultModel');
const {
    PancakeV2Parser,
    PancakeV3Parser,
    BinanceDexRouterParser,
    SmartSwapOrderParser,
    MemeProxyRouterParser,
    FourMemeRouterParser
} = require('./src/parser/SwapParsers');

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        throw new Error('请通过 --tx <hash> 指定需要模拟的交易哈希');
    }
    let txHash = null;
    let sendTx = false;
    let amountStr = null;
    let forceZeroMinOut = false;
    let autoApprove = false;
    for (let i = 0; i < args.length; i += 1) {
        const flag = args[i];
        if (flag === '--tx' && args[i + 1]) {
            txHash = args[i + 1];
            i += 1;
        } else if (flag === '--send') {
            sendTx = true;
        } else if ((flag === '--amount' || flag === '--amount-bnb') && args[i + 1]) {
            amountStr = args[i + 1];
            i += 1;
        } else if (flag === '--force-zero-min') {
            forceZeroMinOut = true;
        } else if (flag === '--approve') {
            autoApprove = true;
        }
    }


    // let sendTx = true;
    // let forceZeroMinOut = true;
    // let autoApprove = true;
    // let txHash = "0x3592912704e1c59682e4f49c65c1524e3cfc860fc1eecc9a15e9653a3bd99167";
    // let amountStr = "0.00001";

    if (!txHash) {
        throw new Error('缺少 --tx 参数');
    }
    const httpUrl = process.env.BSC_HTTP_URL;
    if (!httpUrl) {
        throw new Error('缺少 BSC_HTTP_URL');
    }
    const privateKeyRaw = process.env.PRIVATE_KEY || '';
    if (!privateKeyRaw) {
        throw new Error('缺少 PRIVATE_KEY，用于构造模拟交易的 from 地址');
    }
    const privateKeys = privateKeyRaw
        .split(',')
        .map(pk => pk.trim())
        .filter(Boolean);
    if (privateKeys.length === 0) {
        throw new Error('未解析到任何私钥');
    }

    const provider = new ethers.providers.JsonRpcProvider(httpUrl);
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
        throw new Error(`未查询到交易 ${txHash}`);
    }
    const normalizedTx = normalizeTransaction(tx);

    const wbnbAddress = process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const parsers = createParsers(provider, wbnbAddress);
    let parserResult = null;
    for (const parser of parsers) {
        const parsed = await parser.parse(normalizedTx);
        if (parsed) {
            parserResult = parsed;
            break;
        }
    }
    if (!parserResult) {
        console.log('未匹配到可模拟的协议');
        return;
    }
    const model = buildParseResultModel(normalizedTx, parserResult);
    console.log('解析成功，准备模拟...');
    console.log(JSON.stringify(model, null, 2));

    const spendTokenMeta = model.tokens?.spend || {};
    const spendSymbol = (spendTokenMeta.symbol || '').toUpperCase();
    const spendAddress = (spendTokenMeta.address || '').toLowerCase();
    const buyerConfig = {
        dryRun: !sendTx,
        simulateBeforeSend: true
    };
    if (amountStr) {
        const nativeLike = spendSymbol === 'BNB' || spendSymbol === 'WBNB' || spendAddress === ethers.constants.AddressZero.toLowerCase();
        const usdLike = spendSymbol === 'USDT' || spendSymbol === 'USDC';
        if (nativeLike) {
            try {
                buyerConfig.buyValueBnb = ethers.utils.parseEther(amountStr);
            } catch (err) {
                throw new Error(`解析 --amount 失败: ${err.message}`);
            }
        } else if (usdLike) {
            buyerConfig.buyValueUsd = amountStr;
        } else {
            console.warn(`检测到支付代币 (${spendSymbol || spendAddress}) 暂未支持 --amount 覆盖，将使用默认配置`);
        }
    }
    if (forceZeroMinOut) {
        buyerConfig.forceZeroMinOut = true;
    }
    if (sendTx) {
        console.log('已启用 --send，将在模拟通过后广播真实交易。');
    } else {
        console.log('dry-run 模式，不会真实发送交易。');
    }
    if (amountStr) {
        console.log(`使用自定义买入金额: ${amountStr} （根据支付代币自动识别单位）`);
    }
    if (forceZeroMinOut) {
        console.log('forceZeroMinOut 已开启，最小成交量将强制设为 0');
    }
    if (autoApprove) {
        console.log('启用 --approve，若授权不足将自动发送 approve。');
    }

    const buyer = new SwapBuyer({
        provider,
        privateKeys,
        config: buyerConfig
    });

    const override = buyer.determineOverrideAmount(model);
    if (!override) {
        console.log('无法确定本次买入金额，可能不是买单，终止。');
        return;
    }
    console.log(`本次构造的花费金额(原始数值): ${override.amount.toString()}`);

    const wallets = buyer.wallets || [];
    if (wallets.length === 0) {
        throw new Error('未找到可用钱包');
    }
    const primaryWallet = wallets[0];

    const spendToken = normalizeAddress(override.spendToken);
    const routerAddr = normalizeAddress(model.router || model.target || parserResult.router);
    if (spendToken && spendToken !== ethers.constants.AddressZero && routerAddr) {
        const allowanceEnough = await checkAllowance(spendToken, primaryWallet, routerAddr, override.amount);
        if (!allowanceEnough) {
            if (autoApprove || sendTx) {
                console.log('授权不足，准备发送 approve 交易...');
                await ensureAllowance(spendToken, primaryWallet, routerAddr, override.amount, buyer.config.approvalOptions || {});
                console.log('授权完成');
            } else {
                console.log('授权不足。可以添加 --approve 先授权，或使用 --send 直接实单。');
                return;
            }
        } else {
            console.log('授权充足，跳过 approve');
        }
    }

    const results = await buyer.execute(model, { pendingTx: normalizedTx });
    console.log('模拟结果:');
    results.forEach((res, idx) => {
        console.log(`[${idx}]`, res);
    });
}

function normalizeTransaction(tx) {
    if (!tx) {
        return tx;
    }
    const input = tx.input && tx.input !== '0x' ? tx.input : tx.data;
    const data = tx.data && tx.data !== '0x' ? tx.data : tx.input;
    return Object.assign({}, tx, {
        input: input || '0x',
        data: data || '0x',
        value: tx.value || ethers.constants.Zero
    });
}

function createParsers(provider, wbnbAddress) {
    const list = [];
    const pcsV2Router = process.env.PCS_V2_ROUTER;
    const pcsV2Factory = process.env.PCS_V2_FACTORY;
    if (pcsV2Router && pcsV2Factory) {
        list.push(new PancakeV2Parser({
            provider,
            routerAddress: pcsV2Router,
            factoryAddress: pcsV2Factory,
            wbnbAddress
        }));
    }
    const pcsV3Router = process.env.PCS_V3_ROUTER;
    const pcsV3Factory = process.env.PCS_V3_FACTORY;
    if (pcsV3Router && pcsV3Factory) {
        list.push(new PancakeV3Parser({
            provider,
            routerAddress: pcsV3Router,
            factoryAddress: pcsV3Factory,
            wbnbAddress
        }));
    }
    const smartSwapContract = process.env.SMART_SWAP_ORDER_CONTRACT || '0x3d90f66B534Dd8482b181e24655A9e8265316BE9';
    if (smartSwapContract) {
        list.push(new SmartSwapOrderParser({
            provider,
            contractAddress: smartSwapContract,
            wbnbAddress
        }));
    }
    const memeProxyRouter = process.env.MEME_PROXY_ROUTER || '0x1de460f363AF910f51726DEf188F9004276Bf4bc';
    if (memeProxyRouter) {
        list.push(new MemeProxyRouterParser({
            provider,
            proxyAddress: memeProxyRouter,
            wbnbAddress
        }));
    }
    const binanceRouter = process.env.BINANCE_DEX_ROUTER || '0xb300000b72DEAEb607a12d5f54773D1C19c7028d';
    const binanceFactory = process.env.PCS_V2_FACTORY || process.env.BINANCE_DEX_FACTORY;
    if (binanceRouter && binanceFactory) {
        list.push(new BinanceDexRouterParser({
            provider,
            routerAddress: binanceRouter,
            factoryAddress: binanceFactory,
            wbnbAddress
        }));
    }
    const fourMemeRouter = process.env.FOUR_MEME_ROUTER || '0x5C952063C7fC8610ffDB798152D69F0B9550762B';
    if (fourMemeRouter) {
        list.push(new FourMemeRouterParser({
            provider,
            contractAddress: fourMemeRouter,
            wbnbAddress
        }));
    }
    return list;
}

async function checkAllowance(tokenAddress, wallet, spender, requiredAmount) {
    const erc20 = new ethers.Contract(tokenAddress, [
        'function allowance(address owner, address spender) view returns (uint256)'
    ], wallet.provider);
    const allowance = await erc20.allowance(wallet.address, spender);
    return allowance.gte(requiredAmount);
}

if (require.main === module) {
    main().catch(err => {
        console.error('模拟失败:', err.message || err);
        if (err.stack) {
            console.error(err.stack);
        }
        process.exit(1);
    });
}
