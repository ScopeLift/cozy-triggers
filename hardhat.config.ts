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
};

// Ensure that we have all the environment variables we need.
const privateKey = process.env.PRIVATE_KEY as string;
if (!privateKey) throw new Error('Please set your PRIVATE_KEY in a .env file');

const rpcUrl = process.env.RPC_URL as string;
if (!rpcUrl) throw new Error('Please set your RPC_URL in a .env file');

// Use the default hardhat mnemonic when on localhost
const mnemonic = 'test test test test test test test test test test test junk';

// Helper function to generate a hardhat network config
function createNetworkConfig(network: keyof typeof chainIds): NetworkUserConfig {
  return {
    accounts: [privateKey],
    chainId: chainIds[network],
    url: rpcUrl,
  };
}

// Main hardhat configuration
const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      hardfork: 'london',
      gasPrice: 'auto',
      accounts: { mnemonic },
      chainId: chainIds.hardhat,
      forking: { url: rpcUrl },
    },
    mainnet: createNetworkConfig('mainnet'),
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
        version: '0.8.6',
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
