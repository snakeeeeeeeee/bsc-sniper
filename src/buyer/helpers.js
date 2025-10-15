const { ethers } = require('ethers');

const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

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
    if (normalized.toLowerCase() === ethers.constants.AddressZero.toLowerCase() || normalized.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        return ethers.constants.AddressZero;
    }
    return normalized;
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

async function ensureAllowance(tokenAddress, wallet, spender, requiredAmount, options = {}) {
    if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
        return null;
    }
    if (!requiredAmount || requiredAmount.isZero()) {
        return null;
    }
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, spender);
    if (allowance.gte(requiredAmount)) {
        return null;
    }
    const approveAmount = options.approveAmount || ethers.constants.MaxUint256;
    const tx = await token.approve(spender, approveAmount);
    await tx.wait(options.confirmations ?? 1);
    return tx.hash;
}

function applySlippage(amount, slippageBps = 100) {
    if (!amount) {
        return null;
    }
    const bps = Math.max(0, Math.min(10000, slippageBps));
    const numerator = ethers.BigNumber.from(10000 - bps);
    return amount.mul(numerator).div(10000);
}

function getDeadline(seconds = 60) {
    const now = Math.floor(Date.now() / 1000);
    return now + Math.max(1, seconds);
}

module.exports = {
    normalizeAddress,
    normalizeSwapTokenAddress,
    toBigNumber,
    ensureAllowance,
    applySlippage,
    getDeadline
};
