import { genericCurveThreeTokenBasePoolTests, Addresses, Slots } from '../generic/CurveThreeTokenBasePool.test';

const addresses: Addresses = {
  curve: {
    curve3CryptoAddress: '0x960ea3e3C7FB317332d990873d354E18d7645590',
    curveTokenAddress: '0x8e0B8c8BB9db49a46697F3a5Bb8A308e744821D2',
  },
  tokens: {
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    wbtc: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  }
}

const slots: Slots = {
  tokensBalanceOf: { usdt: '0x33', wbtc: '0x33', weth: '0x33' },
  curveTokenTotalSupply: '0x9',
}

genericCurveThreeTokenBasePoolTests(addresses, slots);