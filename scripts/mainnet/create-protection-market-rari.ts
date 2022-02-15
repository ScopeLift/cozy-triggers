/**
 * @notice Deploys the `RariSharePrice` trigger and creates a protection market
 * @dev To deploy, you must define the RARI_VAULT environment variable and set it equal to one
 * of the keys of the `vaults` variable, such as usdc or dai. Sample deploy commands are below:
 *
 *     RARI_VAULT=usdc yarn hardhat run scripts/mainnet/create-protection-market-rari.ts
 *     RARI_VAULT=dai yarn hardhat run scripts/mainnet/create-protection-market-rari.ts --network mainnet
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../../utils/utils'; // prettier-ignore
import comptrollerAbi from '../../abi/Comptroller.json';

// Constants
const { AddressZero } = hre.ethers.constants;
const twoE16 = '20000000000000000'; // 2%
const eightE17 = '800000000000000000'; // 80%
const cozyMultisig = '0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);

// STEP 1: TRIGGER CONTRACT SETUP
const platformIds = [10];
// const recipient = signer.address;
const recipient = '0xSetRecipientAddressHere'; // subsidy recipient

// Mainnet parameters for various Rari vaults
const vaults = {
  usdc: {
    name: 'Rari USDC Trigger',
    symbol: 'rariUSDC-TRIG',
    description : "Triggers when the Rari USDC vault share price decreases by more than 50% between consecutive checks.", // prettier-ignore
    vaultAddress: '0xC6BF8C8A55f77686720E0a88e2Fd1fEEF58ddf4a',
    irParams: [twoE16, '200000000000000000', '6150000000000000000', eightE17], // JumpRateModelV2 interest rate model constructor parameters
  },
  dai: {
    name: 'Rari DAI Trigger',
    symbol: 'rariDAI-TRIG',
    description : "Triggers when the Rari DAI vault share price decreases by more than 50% between consecutive checks.", // prettier-ignore
    vaultAddress: '0xB465BAF04C087Ce3ed1C266F96CA43f4847D9635', // TODO set this address
    irParams: [twoE16, '170000000000000000', '5300000000000000000', eightE17], // JumpRateModelV2 interest rate model constructor parameters
  },
};

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  // Verify a valid vault was selected
  const vault = process.env.RARI_VAULT as string;
  if (!vault) {
    const msg = "Please define the 'RARI_VAULT' environment variable. Keys of the `vaults` variable are valid values";
    throw new Error(msg);
  }
  if (!Object.keys(vaults).includes(vault)) {
    throw new Error(`Vault '${vault}'' is not a key in the \`vaults\` object`);
  }
  const { name, symbol, description, vaultAddress, irParams } = vaults[vault as keyof typeof vaults];

  // Verify recipient address was set properly
  if (!utils.isAddress(recipient)) throw new Error('\n\n**** Please set the recipient address on line 23 ****\n');

  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.log(`  Deploying protection market for:   Rari ${vault.toUpperCase()} Vault`);
  console.log(`  Deployer address:                  ${signer.address}`);
  console.log(`  Deploying to network:              ${hre.network.name}`);

  const response = await waitForInput('\nDo you want to continue with deployment? y/N\n');
  if (response !== 'y') {
    logFailure('\nUser chose to cancel deployment. Exiting script');
    return;
  }
  logSuccess('Continuing with deployment...\n');

  // DEPLOY INTEREST RATE MODEL
  // Get instance of the Trigger ContractFactory with our signer attached
  const irModelFactory: ContractFactory = await hre.ethers.getContractFactory('JumpRateModelV2', signer);

  // Deploy the interest rate model
  const irModelConstructorArgs = [...irParams, cozyMultisig];
  const irModel: Contract = await irModelFactory.deploy(...irModelConstructorArgs);
  await irModel.deployed();
  logSuccess(`Interest rate model deployed to ${irModel.address}`);

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory('RariSharePrice', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, vaultAddress];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`RariSharePrice trigger deployed to ${trigger.address}`);

  // VERIFY UNDERLYING
  // Let's choose ETH as the underlying, so first we need to check if there's a ETH Money Market.
  // We know that Money Markets have a trigger address of the zero address, so we use that to query the Comptroller
  // for the Money Market address
  const ethAddress = getContractAddress('ETH', chainId);
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const cozyEthAddress = await comptroller.getCToken(ethAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot deploy a protection
  // market with ETH as the underlying
  if (cozyEthAddress === AddressZero) {
    logFailure('No ETH Money Market exists. Exiting script');
    return;
  }
  logSuccess(`Safe to continue: Found ETH Money Market at ${cozyEthAddress}`);

  // DEPLOY PROTECTION MARKET
  // If we're here, a ETH Money Market exists, so it's safe to create our new Protection Market
  const overrides = await getGasPrice(hre, { chainId });
  const tx = await comptroller['deployProtectionMarket(address,address,address)'](
    ethAddress,
    trigger.address,
    irModel.address,
    overrides
  );
  console.log(`Creating Protection Market in transaction ${tx.hash}`);

  // This should emit a ProtectionMarketListed event on success, so let's check for that event. If not found, this
  // method will throw and print the Failure error codes which can be looked up in ErrorReporter.sol
  const { log, receipt } = await findLog(tx, comptroller, 'ProtectionMarketListed', provider);
  logSuccess(`Success! Protection Market deployed to ${log?.args.cToken}`);

  // Done! You have successfully deployed your protection market
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
