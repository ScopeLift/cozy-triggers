/**
 * @notice Deploys the `RibbonV2SharePrice` trigger and creates a protection market
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory, utils } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../../utils/utils'; // prettier-ignore
import comptrollerAbi from '../../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
const name = 'Ribbon T-ETH-C Trigger'; // name
const symbol = 'RibbonT-ETH-C-TRIG'; // symbol
const description = "Triggers when the Ribbon Theta Vault ETH pool virtual price decreases by more than 50% between consecutive checks"; // prettier-ignore
const platformIds = [9]; // platform ID for ribbon
const recipient = '0xSetRecipientAddressHere'; // subsidy recipient
const ribbonVaultAddress = '0x25751853Eab4D0eB3652B5eB6ecB102A2789644B'; // mainnet ribbon vault pool

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  if (!utils.isAddress(recipient)) throw new Error('\n\n**** Please set the recipient address on line 23 ****\n');

  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.log('  Deploying protection market for:   Ribbon Theta Vault V2');
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
  const constructorArgs = [
    '20000000000000000', // baseRatePerYear of 2% = 2e16
    '110000000000000000', // multiplierPerYear of 11% = 1.1e17 gives 13% borrow rate at kink (was 8% before)
    '3700000000000000000', // jumpMultiplierPerYear of 370% = 3.7e17 gives 87% borrow rate at 100% utilization
    '800000000000000000', // kink of 0.8 = 8e17 = sets the model kink at 80% utilization
    '0x1725d89c5cf12F1E9423Dc21FdadC81C491a868b', // Cozy multisig
  ];
  const irModel: Contract = await irModelFactory.deploy(...constructorArgs);
  await irModel.deployed();
  logSuccess(`Interest rate model deployed to ${irModel.address}`);

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory('RibbonV2SharePrice', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, ribbonVaultAddress];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`RibbonV2SharePrice trigger deployed to ${trigger.address}`);

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
