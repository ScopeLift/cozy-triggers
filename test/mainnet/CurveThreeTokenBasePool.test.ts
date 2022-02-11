import { genericCurveThreeTokenBasePoolTests, Addresses, Slots } from '../generic/CurveThreeTokenBasePool.test';

const addresses: Addresses = {
  curve: {
    curve3CryptoAddress: '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',
    curveTokenAddress: '0xc4AD29ba4B3c580e6D59105FFf484999997675Ff',
  },
  tokens: {
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  }
}

const slots: Slots = {
  tokensBalanceOf: { usdt: '0x2', wbtc: '0x0', weth: '0x3' },
  curveTokenTotalSupply: '0x4',
}

genericCurveThreeTokenBasePoolTests(addresses, slots);