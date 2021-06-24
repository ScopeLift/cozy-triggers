import { Contract } from '@ethersproject/contracts';
import { JsonRpcProvider, TransactionResponse } from '@ethersproject/providers';
import { parseEther, parseUnits } from '@ethersproject/units';
import chalk from 'chalk';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import mainnetDeployAddresses from '../deployments/mainnet.json';

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
  YearnProtectionMarket: '0x37e45483B5242c2b3f35ed153dDAf7CE45C1C7B2', // sample protection market deployed on mainnet
};

// Mapping of chainId to contract addresses
const address = { 1: mainnetAddresses };
type ChainId = keyof typeof address;
type ContractNames = keyof typeof mainnetAddresses;

// Logging helper methods
export const logSuccess = (msg: string) => console.log(`${chalk.green('\u2713')} ${msg}`); // \u2713 = check symbol
export const logFailure = (msg: string) => console.log(`${chalk.red('\u2717')} ${msg}`); // \u2717 = x symbol

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
  const chainId = getChainId(hre);
  if (chainId !== 1) throw new Error('Unsupported network');
  const tokenAbi = ['function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'];

  // We impersonate the binance exchange account on mainnet as a source of tokens
  const funderAddress = '0x28C6c06298d514Db089934071355E5743bf21d60';
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
