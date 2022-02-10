import { BigNumber } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { JsonRpcProvider, TransactionResponse } from '@ethersproject/providers';
import { formatUnits, parseEther, parseUnits } from '@ethersproject/units';
import readline from 'readline';
import chalk from 'chalk';
import axios from 'axios';
import { network } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import hardhatConfig from '../hardhat.config';
import mainnetDeployAddresses from '../deployments/mainnet.json';
import arbitrumDeployAddresses from '../deployments/arbitrum.json';

// Rename contract names from the verbose deploy names to something more concise
const mainnetAddresses = {
  ETH: mainnetDeployAddresses.ETH, // placeholder ETH address
  DAI: mainnetDeployAddresses.DAI,
  USDC: mainnetDeployAddresses.USDC,
  WBTC: mainnetDeployAddresses.WBTC,
  Oracle: mainnetDeployAddresses['ChainlinkReporter:Oracle'],
  Comptroller: mainnetDeployAddresses['ComptrollerStatic:Comptroller'],
  InterestRateModelETH: mainnetDeployAddresses['WhitePaperInterestRateModel:ETH'],
  InterestRateModelWBTC: mainnetDeployAddresses['WhitePaperInterestRateModel:WBTC'],
  InterestRateModelStablecoin: mainnetDeployAddresses['JumpRateModelV2:Stablecoins'],
  CozyETH: mainnetDeployAddresses['CErc20Immutable:Money Market:Cozy Ether'],
  CozyDAI: mainnetDeployAddresses['CErc20Immutable:Money Market:Cozy Dai'],
  CozyUSDC: mainnetDeployAddresses['CErc20Immutable:Money Market:Cozy USD Coin'],
  CozyWBTC: mainnetDeployAddresses['CErc20Immutable:Money Market:Cozy Wrapped BTC'],
  Maximillion: mainnetDeployAddresses['Maximillion:Maximillion'],
  YearnProtectionMarket: '0x9affB6D8568cEfa2837d251b1553967430D1a5e5', // sample protection market deployed on mainnet
};

const arbitrumAddresses = {
  ...mainnetAddresses, // Cozy contracts have the same addresses on arbitrum
  DAI: arbitrumDeployAddresses.DAI,
  USDC: arbitrumDeployAddresses.USDC,
  WBTC: arbitrumDeployAddresses.WBTC,
};

const funderAddresses = {
  1: '0x28C6c06298d514Db089934071355E5743bf21d60', // mainnet binance exchange account
  42161: '0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D', // arbitrum binance hot wallet
};

// Mapping of chainId to contract addresses
const address = { 1: mainnetAddresses, 42161: arbitrumAddresses };
type ChainId = keyof typeof address;
type ContractNames = keyof typeof mainnetAddresses;

// Logging helper methods
export const logSuccess = (msg: string) => console.log(`${chalk.green('\u2713')} ${msg}`); // \u2713 = check symbol
export const logFailure = (msg: string) => console.log(`${chalk.red('\u2717')} ${msg}`); // \u2717 = x symbol
export const logWarning = (msg: string) => console.log(chalk.yellow(msg));

/**
 * @notice Gets a contract's address by it's name and chainId
 * @param name Contract name, must be a valid key from `mainnetAddresses`
 * @param chainId Chain ID to get contract from
 * @returns Contract address
 */
export const getContractAddress = (name: string, chainId: number) => {
  if (!Object.keys(address[chainId as ChainId]).includes(name)) {
    throw new Error(`Contract named '${name}' not found for chainId ${chainId}`);
  }
  return address[chainId as ChainId][name as ContractNames];
};

/**
 * @notice Gets the chainId from the hardhat configuration
 * @dev Normally you could get this from `(await ethers.provider.getNetwork()).chainId`, but because these scripts run
 * against a local, forked network, the chain ID is Hardhat's default value of 1337. The helper methods in this file
 * rely on the chain ID to properly fetch contract addresses, so we define this `getChainId()` method to override the
 * chain ID based on which network we've forked locally against
 * @param hre Hardhat runtime environment
 */
export const getChainId = (hre: HardhatRuntimeEnvironment) => {
  const forkUrl = hre.config.networks.hardhat.forking?.url;
  if (!forkUrl) throw new Error('Fork URL not configured');
  if (forkUrl.includes('arbitrum-mainnet')) return 42161;
  if (forkUrl.includes('mainnet')) return 1;
  if (forkUrl.includes('ropsten')) return 3;
  if (forkUrl.includes('rinkeby')) return 4;
  if (forkUrl.includes('goerli')) return 5;
  if (forkUrl.includes('kovan')) return 42;
  throw new Error('Unsupported network');
};

/**
 * @notice Fund an account on a forked network with tokens
 * @dev Currently only configured to work on mainnet
 * @dev When operating on a forked network, our accounts need to get tokens somehow. When forking mainnet, we can
 * either use an initial set of accounts corresponding to accounts that already have the needed tokens, or we can use
 * Hardhat's `hardhat_impersonateAccount` RPC method to transfer ourselves tokens from any account that has them.
 * @param tokenAddress Address of token
 * @param amount Amount to send in human-readable form
 * @param to Account to send the tokens to
 * @param hre HardhatRuntimeEnvironment, used for getting chainID
 */
export const fundAccount = async (tokenAddress: string, amount: string, to: string, hre: HardhatRuntimeEnvironment) => {
  const chainId = getChainId(hre) as keyof typeof funderAddresses;
  const tokenAbi = ['function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'];

  // We impersonate an account on the chain as a source of tokens
  const funderAddress = funderAddresses[chainId];
  await assertSufficientBalance(funderAddress, tokenAddress, amount, hre);
  await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [funderAddress] });
  const signer = await hre.ethers.provider.getSigner(funderAddress);

  if (tokenAddress === mainnetAddresses.ETH) {
    // Transfer ETH from the funderAddress to the wallet
    await signer.sendTransaction({ to, value: parseEther(amount) });
  } else {
    // Transfer tokens from the funderAddress to the wallet
    const token = new Contract(tokenAddress, tokenAbi, signer);
    const decimals = await token.decimals();
    await token.transfer(to, parseUnits(amount, decimals));
  }

  // Stop impersonating the account since it's no longer needed
  await hre.network.provider.request({ method: 'hardhat_stopImpersonatingAccount', params: [funderAddress] });
};

/**
 * @notice Helper method to check that an accounts balance of the given token is above the provided amount
 * @param account Account to check balance of
 * @param tokenAddress Address of token
 * @param amount Amount to send in human-readable form
 * @param hre HardhatRuntimeEnvironment, used for getting provider
 */
const assertSufficientBalance = async (
  account: string,
  tokenAddress: string,
  amount: string,
  hre: HardhatRuntimeEnvironment
) => {
  // Get token contract (only used if tokenAddress is not ETH)
  const tokenAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
  const token = new Contract(tokenAddress, tokenAbi, hre.ethers.provider);

  // Check balances
  const isEth = tokenAddress === mainnetAddresses.ETH;
  const accountBalance = isEth ? await hre.ethers.provider.getBalance(account) : await token.balanceOf(account);
  const desiredBalance = isEth ? parseEther(amount) : parseUnits(amount, await token.decimals());

  // Throw if insufficient balance
  if (accountBalance.lt(desiredBalance)) {
    const message = `The funding address used to acquire tokens for testing has an insufficient balance of the token at address ${tokenAddress}.

    Account:           ${account}
    Current balance:   ${accountBalance}
    Requested amount:  ${desiredBalance}\n\nPlease request an amount less than the account's balance, or update the address used in utils.ts to an address with a sufficient balance.
    `;
    throw new Error(message);
  }
};

/**
 * @notice Returns true if event named `event` was emitted by `contract` in the provided `tx
 * @param tx ethers contract call response, of type ContractTransaction
 * @param contract Instance of an ethers Contract
 * @param event Name of the log to look for
 * @param provider Provider instance
 * @returns receipt if log was found, throws and prints error codes if not
 */
export const findLog = async (
  tx: TransactionResponse,
  contract: Contract,
  event: string,
  provider: JsonRpcProvider
) => {
  // Wait for the transaction to be mined, then get the transaction receipt
  await tx.wait();
  const receipt = await provider.getTransactionReceipt(tx.hash);

  // Use our custom parseLog method to parse logs, that way it does not throw on failure
  const logs = receipt.logs.map(parseLog(contract));

  // For each log in logs, find the first one with a name equal to our target `logName`
  const log = logs.filter((log) => log?.name === event)[0];

  // Found, return the parsed log information and the receipt
  if (log) return { log, receipt };

  // If not found, let's search for Failure logs. If we find one, log the error codes and throw since we should
  // assume it's unsafe to continue execution
  const failureLog = logs.filter((log) => log?.name === 'Failure')[0];
  if (!failureLog) throw new Error(`Expected log name and Failure logs both not found in transaction ${tx.hash}`);
  logFailure(`Error codes: ${failureLog?.args}`);
  throw new Error('Transaction failed. See error codes above and check them against ErrorReporter.sol');
};

/**
 * @notice Wrapper around ethers' parseLog that returns undefined instead of throwing an error (by default an error is
 * thrown if you try parsing a log with the wrong interface)
 * @param contract Instance of an ethers Contract
 * @param log A single `Log` from the tx receipt's logs array
 * @returns The parsed log, or undefined if it could not be parsed
 */
const parseLog = (contract: Contract) => (log: { topics: Array<string>; data: string }) => {
  try {
    return contract.interface.parseLog(log);
  } catch (err) {
    return undefined;
  }
};

// Helper method for waiting on user input. Source: https://stackoverflow.com/a/50890409
export const waitForInput = (query: string) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
};

// Helper method to fetch JSON
const fetch = (url: string) => axios.get(url).then((res) => res);

type EstimatedPrice = {
  confidence: number;
  price: number;
  maxPriorityFeePerGas: number;
  maxFeePerGas: number;
};

type BlockPrice = {
  blockNumber: number;
  baseFeePerGas: number;
  estimatedTransactionCount: number;
  estimatedPrices: EstimatedPrice[];
};

type TxPriceResponse = {
  system: string;
  network: string;
  unit: string;
  maxPrice: number;
  currentBlockNumber: number;
  msSinceLastBlock: number;
  blockPrices: BlockPrice[];
};

type TxPriceConfidence = 99 | 95 | 90 | 80 | 70;

// Gas estimation method return type
type GasEstimate = {
  maxPriorityFeePerGas: BigNumber;
  maxFeePerGas: BigNumber;
};

// Gets the current gas price via TxPrice API
export async function getGasPrice(gasPriceConfidence: TxPriceConfidence = 99): Promise<GasEstimate> {
  try {
    // Send request and find the object with a 99% chance of being included in the next block
    const response: TxPriceResponse = (await fetch('https://api.TxPrice.com/')).data;
    const estimatedPrice = response.blockPrices[0]?.estimatedPrices?.find(
      (price) => price.confidence === gasPriceConfidence
    );

    // Validate API response
    const { maxPriorityFeePerGas, maxFeePerGas } = <EstimatedPrice>estimatedPrice;

    if (!maxPriorityFeePerGas || !maxFeePerGas) {
      console.log(estimatedPrice);
      throw new Error('API did not return valid gas prices');
    }

    if (maxPriorityFeePerGas > 100 || maxFeePerGas > 1000) {
      console.log(estimatedPrice);
      throw new Error('Gas prices are very high');
    }

    // Convert prices to wei
    const maxPriorityFeePerGasWei = parseUnits(String(maxPriorityFeePerGas), 'gwei');
    const maxFeePerGasWei = parseUnits(String(maxFeePerGas), 'gwei');
    return { maxPriorityFeePerGas: maxPriorityFeePerGasWei, maxFeePerGas: maxFeePerGasWei };
  } catch (e) {
    const message = (e as { message: string }).message;
    throw new Error(`Error fetching gas price from TxPrice API: ${message}`);
  }
}

// Reset state between tests by re-forking from mainnet
export async function reset() {
  await network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl: hardhatConfig.networks?.hardhat?.forking?.url,
          blockNumber: hardhatConfig.networks?.hardhat?.forking?.blockNumber, // requires archive node data
        },
      },
    ],
  });
}
