import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'solidity-coverage';
import '@nomiclabs/hardhat-etherscan';

import './tasks/accounts';
import './tasks/clean';

import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import { NetworkUserConfig } from 'hardhat/types';

dotenvConfig({ path: resolve(__dirname, './.env') });

const chainIds = {
  ganache: 1337,
  goerli: 5,
  hardhat: 31337,
  kovan: 42,
  mainnet: 1,
  rinkeby: 4,
  ropsten: 3,
  arbitrum: 42161,
  arbitrumRinkeby: 421611,
};

const chainRpcUrls = {
  mainnet: process.env.RPC_URL as string,
  arbitrum: process.env.RPC_URL_ARBITRUM as string,
};

const forkingBlockNumbers = {
  mainnet: 13735953,
  arbitrum: 5670600,
};

// Ensure that we have all the environment variables we need.
const privateKey = process.env.PRIVATE_KEY as string;
if (!privateKey) throw new Error('Please set your PRIVATE_KEY in a .env file');

// The chain to be forked for hardhat - tests for this chain will be ran
// A default is set so that we don't have to set this variable when using hardhat for non-test/forking purposes
const testChainFork = (process.env.TEST_CHAIN_FORK as keyof typeof chainRpcUrls) ?? 'mainnet';

const testRpcUrl = chainRpcUrls[testChainFork];
if (!testRpcUrl) throw new Error(`Please set your RPC_URL for ${testChainFork} in a .env file`);

// Use the default hardhat mnemonic when on localhost
const mnemonic = 'test test test test test test test test test test test junk';

// Helper function to generate a hardhat network config
function createNetworkConfig(network: keyof typeof chainIds): NetworkUserConfig {
  return {
    accounts: [privateKey],
    chainId: chainIds[network],
    url: chainRpcUrls[network as keyof typeof chainRpcUrls],
  };
}

// Main hardhat configuration
const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      accounts: { mnemonic },
      chainId: chainIds.hardhat,
      forking: { url: testRpcUrl, blockNumber: forkingBlockNumbers[testChainFork] },
    },
    mainnet: createNetworkConfig('mainnet'),
    arbitrum: createNetworkConfig('arbitrum'),
  },
  paths: {
    artifacts: './artifacts',
    cache: './cache',
    sources: './contracts',
    tests: './test',
  },
  mocha: {
    timeout: 0,
  },
  solidity: {
    compilers: [
      {
        // Used for triggers
        version: '0.8.10',
        settings: { metadata: { bytecodeHash: 'none' }, optimizer: { enabled: true, runs: 999999 } },
      },
      {
        // Used for interest rate models
        version: '0.5.17',
        settings: { optimizer: { enabled: true, runs: 999999 } }, // no bytecodeHash setting in this version
      },
    ],
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5',
  },
  etherscan: {
    // Your API key for Etherscan. Obtain one at https://etherscan.io/
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
