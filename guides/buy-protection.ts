/**
 * This guide covers the following:
 *   - Supplying funds to a market
 *   - Entering markets to use supplied funds as collateral
 *   - Using that collateral to borrow funds
 */

import hre from 'hardhat';
import '@nomiclabs/hardhat-ethers';
import { Contract } from 'ethers';
import { getChainId, getContractAddress, logSuccess, logFailure, fundAccount, findLog } from '../utils/utils';
import comptrollerAbi from '../abi/Comptroller.json';
import cozyTokenAbi from '../abi/CozyToken.json';
import cozyEthAbi from '../abi/CozyEther.json';
import erc20Abi from '../abi/ERC20.json';

async function main(): Promise<void> {
  // STEP 0: ENVIRONMENT SETUP
  const supplyAmount = '2'; // Supply 2 ETH
  const borrowAmount = '500'; // Borrow 500 USDC

  const provider = hre.ethers.provider;
  const signer = new hre.ethers.Wallet(process.env.PRIVATE_KEY as string, hre.ethers.provider);
  const chainId = getChainId(hre);
  const { AddressZero } = hre.ethers.constants;
  const { getAddress, parseUnits } = hre.ethers.utils;

  // Since we are testing on a forked mainnet and our account has no funds, we need to initialize the account with
  // the required tokens. This step is not needed when the private key in your .env file has funds on mainnet
  const ethAddress = getContractAddress('ETH', chainId);
  await fundAccount(ethAddress, '10', signer.address, hre); // fund signer with 10 ETH

  // STEP 1: SUPPLY COLLATERAL
  // We know we'll need the Comptroller, so create an instance the Comptroller contract
  const comptrollerAddress = getContractAddress('Comptroller', chainId);
  const comptroller = new Contract(comptrollerAddress, comptrollerAbi, signer); // connect signer for sending transactions

  // Let's say we have ETH to use as collateral
  // The first check is to make sure an ETH Money Market exists that we can supply to. We know that Money Markets
  // have a trigger address of the zero address, so we use that to query the Comptroller fo the Money Market address
  const cozyEthAddress = await comptroller.getCToken(ethAddress, AddressZero);

  // If the returned address is the zero address, a money market does not exist and we cannot supply ETH
  if (cozyEthAddress === AddressZero) {
    logFailure('No ETH Money Market exists. Exiting script');
    return;
  }
  logSuccess(`Safe to continue: Found ETH Money Market at ${cozyEthAddress}`);

  // Create a contract instance of the Cozy ETH Money Market
  const cozyEth = new Contract(cozyEthAddress, cozyEthAbi, signer); // for tokens: `new Contract(cozyEthAddress, cozyTokenAbi, signer)`

  // We're now ready to supply the collateral to the market, but there's some preparation we need to do beforehand.
  // First, recall that ETH has 18 decimal places, so we need to take that into account.
  const parsedSupplyAmount = parseUnits(supplyAmount, 18); // scale amount based on number of decimals

  // If using a token, here is where you'd approve the Cozy Money Market contract to spend your tokens. If you trust
  // the Cozy contract, approve it to spend the maximum possible amount to avoid future approvals and save gas. Below
  // we show a sample snippet of an approval transaction and verifying it was successful
  //   const approveTx = await token.approve(cozyToken.address, MaxUint256);
  //   await approveTx.wait();
  //   const allowance = await token.allowance(signer.address, cozyToken.address);
  //   if (!allowance.eq(MaxUint256)) {
  //     logFailure('CozyToken does not have sufficient allowance to spend our token. Exiting script');
  //     return;
  //   }
  //   logSuccess('Approval transaction successful. Ready to mint CozyToken with our token');

  // Ready to mint our CozyETH from ETH
  const mintTx = await cozyEth.mint({ value: parsedSupplyAmount, gasLimit: '5000000' }); // for tokens: `await cozyToken.mint(parsedSupplyAmount)`
  const { log: mintLog, receipt: mintReceipt } = await findLog(mintTx, cozyEth, 'Mint', provider);
  logSuccess(`CozyETH successfully minted in transaction ${mintReceipt.transactionHash}`);

  // STEP 2: ENTER MARKETS
  // Supplying assets does not automatically mean we can use them as collateral. To do that, we need to explicitly
  // call enterMarkets on the Comptroller for each asset we want to use as collateral. For now, that's just ETH.
  // (We use `em` as shorthand for `enterMarkets` in our variable names)
  const markets = [cozyEth.address];
  const emTx = await comptroller.enterMarkets(markets);
  const { log: emLog, receipt: emReceipt } = await findLog(emTx, comptroller, 'MarketEntered', provider);
  logSuccess(`Markets entered successfully: ETH can now be used as collateral`);

  // STEP 3: BORROW FUNDS
  // Your account is now ready to borrow funds

  // We want to borrow protected USDC so we can deposit it straight into Yearn's yUSDC vault, so first let's verify the
  // underlying token we'd borrow is in fact USDC
  const usdc = new Contract(getContractAddress('USDC', chainId), erc20Abi, signer);
  const yearnProtectionMarketAddress = getContractAddress('YearnProtectionMarket', chainId);
  const yearnProtectionMarket = new Contract(yearnProtectionMarketAddress, cozyTokenAbi, signer);
  const underlying = await yearnProtectionMarket.underlying();
  if (usdc.address !== getAddress(underlying)) {
    // We use getAddress() to ensure both addresses are checksummed before comparing them. If this block executes,
    // the underlying of the protection market is not the underlying we want, so we exit the script
    logFailure('USDC addresses do not match. Exiting script');
    return;
  }

  // Now we execute the borrow
  const parsedBorrowAmount = parseUnits(borrowAmount, await usdc.decimals()); // scale amount based on number of decimals
  const borrowTx = await yearnProtectionMarket.borrow(parsedBorrowAmount);
  const { log: borrowLog, receipt: borrowReceipt } = await findLog(borrowTx, yearnProtectionMarket, 'Borrow', provider);
  logSuccess(`Protected USDC borrowed in transaction ${borrowReceipt.transactionHash}`);

  // Done! You are now supplying ETH as collateral to borrow protected USDC. The USDC debt will not need
  // to be paid back if the Yearn trigger event occurs, so the borrowed USDC can now be safely supplied to Yearn
}

// We recommend this pattern to be able to use async/await everywhere and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
