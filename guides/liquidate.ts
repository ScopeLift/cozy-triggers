/**
 * This guide covers the following:
 *   - Checking available liquidity and shortfall for a given account
 *   - Computing the maximum amount of funds that can be repaid when liquidating
 *   - Liquidating an account that has a shortfall
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract } from 'ethers';
import { getChainId, getContractAddress, logSuccess, logFailure, findLog, fundAccount } from '../utils/utils';
import comptrollerAbi from '../abi/Comptroller.json';
import cozyTokenAbi from '../abi/CozyToken.json';

async function main(): Promise<void> {
  // STEP 0: ENVIRONMENT SETUP
  const provider = hre.ethers.provider;
  const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
  const chainId = getChainId(hre);

  const { Zero } = hre.ethers.constants;
  const { formatUnits } = hre.ethers.utils;

  // Since we are testing on a forked mainnet and our account has no funds, we need to initialize the account with
  // the required tokens. This step is not needed when the private key in your .env file has funds on mainnet
  const ethAddress = getContractAddress('ETH', chainId);
  await fundAccount(ethAddress, '10', signer.address, hre); // fund signer with 10 ETH

  // STEP 1: CHECK ACCOUNT LIQUIDITY
  // The amount of collateral an account has have is computed by multiplying the supplied balance in a market by that
  // market's collateral factor, and summing that across all markets. Total borrow balances are subtracted from that,
  // resulting in an Account Liquidity value. Quoting from the Compound documentation:
  //
  //   Account Liquidity represents the USD value borrowable by a user, before it reaches liquidation. Users with
  //   a shortfall (negative liquidity) are subject to liquidation, and can’t withdraw or borrow assets until
  //   Account Liquidity is positive again.
  //
  // To liquidate an account, that account must have a shortfall. We can check if an account has a shortfall as
  // shown below. Since we can't guarantee an existing account is ready to be liquidated we use an arbitrary address
  // below and explain what you'd expect if this account could be liquidated,
  const comptrollerAddress = getContractAddress('Comptroller', chainId); // get address of the Comptroller
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions
  const borrowerToLiquidate = '0x0000000000000000000000000000000000000001'; // enter address to liquidate here
  const [errorCode, liquidity, shortfall] = await comptroller.getAccountLiquidity(borrowerToLiquidate); // check their liquidity

  // Make sure there were no errors reading the data
  if (errorCode.toString() !== '0') {
    logFailure(`Could not read liquidity. Received error code ${errorCode}. Exiting script`);
    return;
  }

  // There were no errors, so now we check if we have an excess or a shortfall. One and only one of `shortfall`
  // and `liquidity` will be above zero. (Since our chosen account above has no shortfall, you'll need to comment out
  // the return statements to move past this section)
  if (shortfall.gt(Zero)) {
    logSuccess(`Account is under-collateralized and can be liquidated! Shortfall amount: ${shortfall}`);
  } else if (liquidity.gt(Zero)) {
    logFailure(`Account has excess liquidity and is safe. Amount of liquidity: ${liquidity}. Exiting script`);
    return;
  } else {
    logFailure('Account has no liquidity and no shortfall. Exiting script.');
    return;
  }

  // STEP 2: PERFORM LIQUIDATION
  // The account can now be liquidated. Quoting from Compound's documentation:
  //
  //   When a liquidation occurs, a liquidator may repay some or all of an outstanding borrow on behalf of a borrower
  //   and in return receive a discounted amount of collateral held by the borrower; this discount is defined as the
  //   liquidation incentive.
  //
  //   A liquidator may close up to a certain fixed percentage (i.e. close factor) of any individual outstanding
  //   borrow of the underwater account. Liquidators must interact with each cToken contract in which they wish to
  //   repay a borrow and seize another asset as collateral. When collateral is seized, the liquidator is transferred
  //   cTokens, which they may redeem the same as if they had supplied the asset themselves. Users must approve each
  //   cToken contract before calling liquidate (i.e. on the borrowed asset which they are repaying), as they are
  //   transferring funds into the contract.

  // Let's check the max close factor that can be liquidated for Cozy
  const closeFactor = await comptroller.closeFactorMantissa();
  logSuccess(`Close factor: ${formatUnits(closeFactor, 18)}`);

  // First we need to choose which collateral of the borrower we want to seize. If needed, we could find a list of
  // available collateral options using the same process as "Step 1: Viewing Positions" in manage-protection.ts. For
  // simplicity, here we'll assume the collateral is regular cozyETH and the borrow is a protected Yearn USDC vault
  const cozyEthAddress = getContractAddress('CozyETH', chainId);
  const yearnProtectionMarketAddress = getContractAddress('YearnProtectionMarket', chainId);
  const yearnProtectionMarket = new Contract(yearnProtectionMarketAddress, cozyTokenAbi, signer);

  // Next we choose an amount of their debt to repay. The max amount we can repay is equal to the closeFactor multiplied
  // by their borrow balance, so let's check their borrow balance
  const usdcBorrowed = await yearnProtectionMarket.borrowBalanceStored(borrowerToLiquidate);

  // If we wanted to liquidate the max amount, we can compute this below. Here we divide the amount by 1e18 because
  // we multiply the USDC amount (6 decimals) by the closeFactor (18 decimals), giving us a 24 decimal number. The
  // liquidation amount should be in units of the borrowed asset, which is USDC, so we divide by 1e18 to get there
  const scale = '1000000000000000000'; // 1e18
  const repayAmount = usdcBorrowed.mul(closeFactor).div(scale);
  logSuccess(`Ready to repay ${repayAmount.toString()} USDC`);

  // Execute the liquidation. In this case, since our account has zero shortfall, we expect the findLog method to
  // report that the LiquidateBorrow event was not found and print error code 3. This corresponds to
  // COMPTROLLER_REJECTION. Looking at the Comptroller's `liquidateBorrowAllowed` hook, we'll find the Comptroller
  // rejected the liquidation because there is no shortfall, i.e. the borrower cannot be liquidated
  const tx = await yearnProtectionMarket.liquidateBorrow(borrowerToLiquidate, repayAmount, cozyEthAddress);
  await findLog(tx, yearnProtectionMarket, 'LiquidateBorrow', provider); // verify things worked successfully
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
