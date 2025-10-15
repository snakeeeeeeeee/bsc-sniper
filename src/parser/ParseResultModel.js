const { ethers } = require('ethers');

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

function bnToString(value) {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (value.toString) {
        return value.toString();
    }
    return null;
}

function normalizeLeg(leg) {
    if (!leg) {
        return null;
    }
    return {
        amountRaw: bnToString(leg.amount),
        formatted: leg.amountFormatted || null,
        type: leg.type || 'exact',
        token: leg.token ? {
            address: leg.token.address || null,
            symbol: leg.token.symbol || null,
            decimals: Number.isFinite(leg.token.decimals) ? leg.token.decimals : 18
        } : null
    };
}

function buildParseResultModel(pendingTx, parserResult) {
    const sender = normalizeAddress(pendingTx.from);
    const target = normalizeAddress(pendingTx.to);
    const recipient = normalizeAddress(parserResult.recipient) || sender;
    const tradeSummary = parserResult.tradeSummary || {};
    const spendLeg = normalizeLeg(tradeSummary.spend);
    const receiveLeg = normalizeLeg(tradeSummary.receive);
    const action = tradeSummary.action || parserResult.action || 'swap';

    return {
        timestamp: new Date().toISOString(),
        txHash: pendingTx.hash || pendingTx.transactionHash || null,
        sender,
        target,
        protocol: parserResult.protocol || 'unknown',
        method: parserResult.method || parserResult.selector || 'unknown',
        router: parserResult.router || parserResult.contract || null,
        contract: parserResult.contract || null,
        selector: parserResult.selector || null,
        recipient,
        action,
        amountIn: bnToString(parserResult.amountIn) || (spendLeg ? spendLeg.amountRaw : null),
        amountOutMin: bnToString(parserResult.amountOutMin) || (receiveLeg ? receiveLeg.amountRaw : null),
        amountOut: bnToString(parserResult.amountOut),
        amountInMax: bnToString(parserResult.amountInMax || parserResult.amountInMaximum),
        amounts: {
            spend: spendLeg,
            receive: receiveLeg
        },
        tokens: {
            spend: spendLeg?.token || null,
            receive: receiveLeg?.token || null
        },
        raw: {
            pendingTx,
            parserResult
        }
    };
}

module.exports = {
    buildParseResultModel
};
