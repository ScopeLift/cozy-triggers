/**
 * @notice Deploys the `YearnCrvTricrypto` trigger and creates a protection market
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract, ContractFactory } from 'ethers';
import chalk from 'chalk';
import { getChainId, getContractAddress, getGasPrice, logSuccess, logFailure, findLog, waitForInput } from '../utils/utils'; // prettier-ignore
import comptrollerAbi from '../abi/Comptroller.json';

// STEP 0: ENVIRONMENT SETUP
const provider = hre.ethers.provider;
const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
const chainId = getChainId(hre);
const { AddressZero } = hre.ethers.constants;

// STEP 1: TRIGGER CONTRACT SETUP
const name = 'Yearn Curve Tricrypto Trigger'; // name
const symbol = 'yCRV-TRICRYPTO-TRIG'; // symbol
const description = 'Triggers when the Yearn vault share price decreases, or the Curve Tricrypto pool fails'; // description
const platformIds = [1, 3]; // platform IDs for Yearn and Curve, respectively
const recipient = '0x1234567890AbcdEF1234567890aBcdef12345678'; // subsidy recipient
const yearnVaultAddress = '0x3D980E50508CFd41a13837A60149927a11c03731'; // mainnet Yearn crvTricrypto vault
const curveTricryptoAddress = '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46'; // mainnet Curve Tricrypto pool

// STEP 2: TRIGGER CONTRACT DEVELOPMENT
// For this step, see the ITrigger.sol and MockTrigger.sol examples and the corresponding documentation

// STEP 3: PROTECTION MARKET DEPLOYMENT
async function main(): Promise<void> {
  // Compile contracts to make sure we're using the latest version of the trigger contracts
  await hre.run('compile');

  // VERIFICATION
  // Verify the user is ok with the provided inputs
  console.log(chalk.bold.yellow('\nPLEASE VERIFY THE BELOW PARAMETERS\n'));
  console.log('  Deploying protection market for:   Yearn');
  console.log(`  Deployer address:                  ${signer.address}`);
  console.log(`  Deploying to network:              ${hre.network.name}`);

  const response = await waitForInput('\nDo you want to continue with deployment? y/N\n');
  if (response !== 'y') {
    logFailure('\nUser chose to cancel deployment. Exiting script');
    return;
  }
  logSuccess('Continuing with deployment...\n');

  // DEPLOY TRIGGER
  // Get instance of the Trigger ContractFactory with our signer attached
  const triggerFactory: ContractFactory = await hre.ethers.getContractFactory('YearnCrvTricrypto', signer);

  // Deploy the trigger contract (last constructor parameter is specific to the mock trigger contract)
  const triggerParams = [name, symbol, description, platformIds, recipient, yearnVaultAddress, curveTricryptoAddress];
  const trigger: Contract = await triggerFactory.deploy(...triggerParams);
  await trigger.deployed();
  logSuccess(`YearnCrvTricrypto trigger deployed to ${trigger.address}`);

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
  const overrides = { gasPrice: await getGasPrice() };
  const tx = await comptroller['deployProtectionMarket(address,address)'](ethAddress, trigger.address, overrides);
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
